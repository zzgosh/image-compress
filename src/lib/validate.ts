export const MAX_FILE_BYTES = 20 * 1024 * 1024
export const MAX_FILE_COUNT = 30
export const MAX_TOTAL_BYTES = 80 * 1024 * 1024
export const MAX_IMAGE_PIXELS = 60_000_000
export const PROCESSING_CONCURRENCY = 2

const ASCII_SAFE_FILE_CHAR = /[^A-Za-z0-9._-]/g

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
