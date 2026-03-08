export const DEFAULT_UPLOAD_MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024
export const DEFAULT_UPLOAD_MAX_FILE_COUNT = 30
export const DEFAULT_UPLOAD_MAX_TOTAL_SIZE_BYTES = 80 * 1024 * 1024
export const MAX_IMAGE_PIXELS = 60_000_000
export const PROCESSING_CONCURRENCY = 2

export interface UploadLimits {
  maxFileCount: number
  maxFileSizeBytes: number
  maxTotalSizeBytes: number
}

const INVALID_FILE_NAME_CHAR = /[\u0000-\u001F\u007F<>:"/\\|?*]+/g
const TRAILING_DOTS_OR_SPACES = /[. ]+$/g
const ASCII_FALLBACK_UNSAFE_CHAR = /[^\x20-\x7E]+/g
const QUOTED_STRING_ESCAPE_CHAR = /["\\]/g

const splitFileName = (fileName: string): { baseName: string; extension: string } => {
  const dotIndex = fileName.lastIndexOf('.')
  if (dotIndex <= 0 || dotIndex === fileName.length - 1) {
    return { baseName: fileName, extension: '' }
  }

  return {
    baseName: fileName.slice(0, dotIndex),
    extension: fileName.slice(dotIndex + 1)
  }
}

const sanitizeRawName = (rawName: string): string =>
  rawName
    .normalize('NFC')
    .replace(INVALID_FILE_NAME_CHAR, '_')
    .replace(TRAILING_DOTS_OR_SPACES, '')
    .trim()

const buildAsciiFallbackFileName = (fileName: string, fallbackName: string): string => {
  const { baseName, extension } = splitFileName(fileName)
  const asciiBase = baseName.replace(ASCII_FALLBACK_UNSAFE_CHAR, '_').replace(/_+/g, '_').trim()
  const asciiExtension = extension.replace(ASCII_FALLBACK_UNSAFE_CHAR, '').trim()
  const normalizedBase = asciiBase || fallbackName

  return asciiExtension ? `${normalizedBase}.${asciiExtension}` : normalizedBase
}

const escapeQuotedString = (value: string): string => value.replace(QUOTED_STRING_ESCAPE_CHAR, '\\$&')

const encodeRfc5987Value = (value: string): string =>
  encodeURIComponent(value).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)

const isInvalidNormalizedName = (value: string): boolean => value === '' || /^\.+$/.test(value)

export const sanitizeFileName = (rawName: string, fallbackName: string): string => {
  const cleaned = sanitizeRawName(rawName)
  if (isInvalidNormalizedName(cleaned)) {
    return fallbackName
  }

  return cleaned
}

export const normalizeZipName = (rawZipName: string | undefined): string => {
  if (!rawZipName || rawZipName.trim() === '') {
    return 'compressed_images.zip'
  }

  const cleaned = sanitizeRawName(rawZipName)
  if (isInvalidNormalizedName(cleaned)) return 'compressed_images.zip'

  return cleaned.endsWith('.zip') ? cleaned : `${cleaned}.zip`
}

export const buildAttachmentContentDisposition = (fileName: string): string => {
  const normalizedName = sanitizeFileName(fileName, 'download')
  const asciiFallback = buildAsciiFallbackFileName(normalizedName, 'download')

  return `attachment; filename="${escapeQuotedString(asciiFallback)}"; filename*=UTF-8''${encodeRfc5987Value(normalizedName)}`
}
