import pLimit from 'p-limit'
import sharp from 'sharp'
import { HttpError, type CompressedImageResult, type UploadedImage } from '../types/api.js'
import { MAX_IMAGE_PIXELS, PROCESSING_CONCURRENCY } from './validate.js'

type SupportedImageFormat = 'jpg' | 'png' | 'webp'

const OUTPUT_FORMAT_TO_MIME = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp'
} as const

const OUTPUT_FORMAT_TO_EXTENSION = {
  jpg: 'jpg',
  png: 'png',
  webp: 'webp'
} as const

const SHARP_FORMAT_TO_TARGET: Record<string, SupportedImageFormat | undefined> = {
  jpeg: 'jpg',
  png: 'png',
  webp: 'webp'
}
const OUTPUT_NAME_SUFFIX = '_compressed'

// 固定压缩配置：服务侧死配置，不对外暴露参数，避免 API 复杂度扩散。
const JPEG_QUALITY = 75
const WEBP_QUALITY = 75
const PNG_PALETTE_QUALITY = 75
const PNG_PALETTE_EFFORT = 7
const PNG_PALETTE_DITHER = 0

const globalLimit = pLimit(PROCESSING_CONCURRENCY)

const splitFileName = (fileName: string): { baseName: string; extension: string } => {
  const lastDotIndex = fileName.lastIndexOf('.')
  if (lastDotIndex <= 0 || lastDotIndex === fileName.length - 1) {
    return { baseName: fileName, extension: '' }
  }

  return {
    baseName: fileName.slice(0, lastDotIndex),
    extension: fileName.slice(lastDotIndex + 1)
  }
}

const buildOutputFileName = (sourceFileName: string, format: SupportedImageFormat): string => {
  const parts = splitFileName(sourceFileName)
  const normalizedBase = parts.baseName.endsWith(OUTPUT_NAME_SUFFIX) ? parts.baseName : `${parts.baseName}${OUTPUT_NAME_SUFFIX}`

  // JPEG 文件名兼容：如果输入文件扩展名为 .jpeg，则输出也使用 .jpeg（仍为 image/jpeg）。
  if (format === 'jpg' && parts.extension.toLowerCase() === 'jpeg') {
    return `${normalizedBase}.jpeg`
  }

  return `${normalizedBase}.${OUTPUT_FORMAT_TO_EXTENSION[format]}`
}

const createPipeline = (inputBuffer: Buffer): sharp.Sharp =>
  sharp(inputBuffer, { failOn: 'warning', limitInputPixels: MAX_IMAGE_PIXELS }).rotate()

const encodeImage = async (inputBuffer: Buffer, format: SupportedImageFormat): Promise<Buffer> => {
  const pipeline = createPipeline(inputBuffer)

  if (format === 'jpg') {
    return pipeline.jpeg({ quality: JPEG_QUALITY, mozjpeg: true }).toBuffer()
  }

  if (format === 'webp') {
    return pipeline.webp({ quality: WEBP_QUALITY }).toBuffer()
  }

  // PNG: 通过 palette 量化实现可观的体积下降（有损），并用 dither=0 降低噪点。
  // 仍保留“变大回退原图”，确保不会因为再编码导致体积增长。
  return pipeline.png({ quality: PNG_PALETTE_QUALITY, effort: PNG_PALETTE_EFFORT, dither: PNG_PALETTE_DITHER }).toBuffer()
}

const detectSourceInfo = async (inputBuffer: Buffer): Promise<{ format: SupportedImageFormat; needsRotate: boolean }> => {
  let metadata: sharp.Metadata
  try {
    metadata = await sharp(inputBuffer, { failOn: 'warning', limitInputPixels: MAX_IMAGE_PIXELS }).metadata()
  } catch (error) {
    const message = (error as Error)?.message ?? ''
    if (message.includes('pixel limit')) {
      throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'image resolution exceeds pixel limit')
    }
    throw new HttpError(422, 'PROCESSING_FAILED', 'failed to decode image')
  }

  const width = metadata.width ?? 0
  const height = metadata.height ?? 0
  if (width > 0 && height > 0 && width * height > MAX_IMAGE_PIXELS) {
    throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'image resolution exceeds pixel limit')
  }

  const detectedFormat = metadata.format ? SHARP_FORMAT_TO_TARGET[metadata.format] : undefined
  if (!detectedFormat) {
    throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'only jpg, png, webp images are supported')
  }

  const orientation = metadata.orientation
  const needsRotate = typeof orientation === 'number' && orientation !== 1

  return { format: detectedFormat, needsRotate }
}

const compressSingleImage = async (file: UploadedImage): Promise<CompressedImageResult> => {
  const source = await detectSourceInfo(file.buffer)
  const sourceFormat = source.format

  let outputBuffer: Buffer
  try {
    outputBuffer = await encodeImage(file.buffer, sourceFormat)
  } catch (error) {
    const message = (error as Error)?.message ?? ''
    if (message.includes('pixel limit')) {
      throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'image resolution exceeds pixel limit')
    }
    throw new HttpError(422, 'PROCESSING_FAILED', 'failed to encode image')
  }

  let outputFormat: SupportedImageFormat = sourceFormat
  let usedFallback = false
  let outputFileName = buildOutputFileName(file.fileName, outputFormat)

  // 统一启用“变大回退原图”，避免再编码导致体积增长。
  if (outputBuffer.length >= file.byteLength) {
    outputBuffer = file.buffer
    usedFallback = true
    outputFileName = file.fileName
  }

  return {
    sourceFileName: file.fileName,
    fileName: outputFileName,
    inputMimeType: OUTPUT_FORMAT_TO_MIME[sourceFormat],
    outputMimeType: OUTPUT_FORMAT_TO_MIME[outputFormat],
    originalBytes: file.byteLength,
    compressedBytes: outputBuffer.length,
    usedFallback,
    buffer: outputBuffer
  }
}

export const compressImages = async (files: UploadedImage[]): Promise<CompressedImageResult[]> =>
  Promise.all(files.map((file) => globalLimit(() => compressSingleImage(file))))
