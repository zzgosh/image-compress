import pLimit from 'p-limit'
import sharp from 'sharp'
import { HttpError, type CompressedImageResult, type CompressionRequestOptions, type TargetFormat, type UploadedImage } from '../types/api.js'

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

const SHARP_FORMAT_TO_TARGET: Record<string, Exclude<TargetFormat, 'keep'> | undefined> = {
  jpeg: 'jpg',
  png: 'png',
  webp: 'webp'
}
const OUTPUT_NAME_SUFFIX = '_compressed'

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

const buildOutputFileName = (sourceFileName: string, format: Exclude<TargetFormat, 'keep'>, forceTargetFormat: boolean): string => {
  const parts = splitFileName(sourceFileName)
  const normalizedBase = parts.baseName.endsWith(OUTPUT_NAME_SUFFIX) ? parts.baseName : `${parts.baseName}${OUTPUT_NAME_SUFFIX}`

  if (!forceTargetFormat && parts.extension) {
    return `${normalizedBase}.${parts.extension}`
  }

  return `${normalizedBase}.${OUTPUT_FORMAT_TO_EXTENSION[format]}`
}

const encodeImage = async (inputBuffer: Buffer, format: Exclude<TargetFormat, 'keep'>, quality: number): Promise<Buffer> => {
  const pipeline = sharp(inputBuffer, { failOn: 'warning' })

  if (format === 'jpg') {
    return pipeline.jpeg({ quality, mozjpeg: true }).toBuffer()
  }

  if (format === 'webp') {
    return pipeline.webp({ quality }).toBuffer()
  }

  return pipeline.png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer()
}

const detectSourceFormat = async (inputBuffer: Buffer): Promise<Exclude<TargetFormat, 'keep'>> => {
  let metadata: sharp.Metadata
  try {
    metadata = await sharp(inputBuffer).metadata()
  } catch (error) {
    throw new HttpError(422, 'PROCESSING_FAILED', 'failed to decode image')
  }

  const detectedFormat = metadata.format ? SHARP_FORMAT_TO_TARGET[metadata.format] : undefined
  if (!detectedFormat) {
    throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'only jpg, png, webp images are supported')
  }

  return detectedFormat
}

const compressSingleImage = async (file: UploadedImage, options: CompressionRequestOptions): Promise<CompressedImageResult> => {
  const sourceFormat = await detectSourceFormat(file.buffer)
  const forceTargetFormat = options.targetFormat !== 'keep'
  const targetFormat: Exclude<TargetFormat, 'keep'> = forceTargetFormat
    ? (options.targetFormat as Exclude<TargetFormat, 'keep'>)
    : sourceFormat

  let outputBuffer = await encodeImage(file.buffer, targetFormat, options.quality)
  let outputFormat: Exclude<TargetFormat, 'keep'> = targetFormat
  let usedFallback = false

  if (!forceTargetFormat && outputBuffer.length >= file.byteLength) {
    outputBuffer = file.buffer
    outputFormat = sourceFormat
    usedFallback = true
  }

  return {
    sourceFileName: file.fileName,
    fileName: buildOutputFileName(file.fileName, outputFormat, forceTargetFormat),
    inputMimeType: file.mimeType,
    outputMimeType: OUTPUT_FORMAT_TO_MIME[outputFormat],
    originalBytes: file.byteLength,
    compressedBytes: outputBuffer.length,
    usedFallback,
    buffer: outputBuffer
  }
}

export const compressImages = async (
  files: UploadedImage[],
  options: CompressionRequestOptions,
  concurrency: number
): Promise<CompressedImageResult[]> => {
  const limit = pLimit(concurrency)
  return Promise.all(files.map((file) => limit(() => compressSingleImage(file, options))))
}
