import { HttpError, type CompressionRequestOptions, type OutputMode, type TargetFormat } from '../types/api.js'

export const MAX_FILE_BYTES = 20 * 1024 * 1024
export const MAX_FILE_COUNT = 30
export const MAX_TOTAL_BYTES = 80 * 1024 * 1024
export const PROCESSING_CONCURRENCY = 2
export const DEFAULT_QUALITY = 75

const SUPPORTED_INPUT_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])
const TARGET_FORMATS = new Set<TargetFormat>(['keep', 'jpg', 'png', 'webp'])
const OUTPUT_MODES = new Set<OutputMode>(['auto', 'image', 'zip'])

const IMAGE_MIME_ALIAS_MAP: Record<string, string> = {
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg'
}

const ASCII_SAFE_FILE_CHAR = /[^A-Za-z0-9._-]/g

export const normalizeImageMimeType = (rawMimeType: string): string => {
  const mimeType = rawMimeType.toLowerCase().trim()
  return IMAGE_MIME_ALIAS_MAP[mimeType] ?? mimeType
}

export const isSupportedInputMimeType = (mimeType: string): boolean => SUPPORTED_INPUT_MIME_TYPES.has(mimeType)

const parseQuality = (rawQuality: string | undefined): number => {
  if (!rawQuality || rawQuality.trim() === '') {
    return DEFAULT_QUALITY
  }

  if (!/^\d+$/.test(rawQuality.trim())) {
    throw new HttpError(400, 'INVALID_ARGUMENT', 'quality must be an integer between 1 and 100')
  }

  const quality = Number.parseInt(rawQuality, 10)
  if (quality < 1 || quality > 100) {
    throw new HttpError(400, 'INVALID_ARGUMENT', 'quality must be between 1 and 100')
  }

  return quality
}

const parseTargetFormat = (rawTargetFormat: string | undefined): TargetFormat => {
  if (!rawTargetFormat || rawTargetFormat.trim() === '') {
    return 'keep'
  }

  const targetFormat = rawTargetFormat.toLowerCase().trim() as TargetFormat
  if (!TARGET_FORMATS.has(targetFormat)) {
    throw new HttpError(400, 'INVALID_ARGUMENT', 'targetFormat must be one of keep, jpg, png, webp')
  }

  return targetFormat
}

const parseOutputMode = (rawOutputMode: string | undefined): OutputMode => {
  if (!rawOutputMode || rawOutputMode.trim() === '') {
    return 'auto'
  }

  const output = rawOutputMode.toLowerCase().trim() as OutputMode
  if (!OUTPUT_MODES.has(output)) {
    throw new HttpError(400, 'INVALID_ARGUMENT', 'output must be one of auto, image, zip')
  }

  return output
}

const sanitizeRawName = (rawName: string): string => rawName.replace(/[\\/]+/g, '_').replace(ASCII_SAFE_FILE_CHAR, '_').trim()

export const sanitizeFileName = (rawName: string, fallbackName: string): string => {
  const cleaned = sanitizeRawName(rawName)
  if (!cleaned) return fallbackName

  if (cleaned.startsWith('.')) {
    return fallbackName
  }

  return cleaned
}

export const normalizeZipName = (rawZipName: string | undefined): string => {
  if (!rawZipName || rawZipName.trim() === '') {
    return 'compressed_images.zip'
  }

  const cleaned = sanitizeRawName(rawZipName)
  if (!cleaned) return 'compressed_images.zip'

  return cleaned.endsWith('.zip') ? cleaned : `${cleaned}.zip`
}

export const getDefaultUploadFileName = (index: number, mimeType: string): string => {
  const extension = mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : 'jpg'
  return `image_${index}.${extension}`
}

export const parseCompressionOptions = (fields: Record<string, string>): CompressionRequestOptions => {
  return {
    quality: parseQuality(fields.quality),
    targetFormat: parseTargetFormat(fields.targetFormat),
    output: parseOutputMode(fields.output)
  }
}
