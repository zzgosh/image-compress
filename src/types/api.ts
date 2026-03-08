export type ApiErrorCode =
  | 'INVALID_ARGUMENT'
  | 'UNAUTHORIZED'
  | 'PAYLOAD_TOO_LARGE'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'PROCESSING_FAILED'
  | 'NOT_FOUND'
  | 'INSUFFICIENT_STORAGE'
  | 'INTERNAL_ERROR'

export interface ApiErrorPayload {
  error: {
    code: ApiErrorCode
    message: string
  }
}

export interface UploadedImage {
  buffer: Buffer
  fileName: string
  byteLength: number
}

export interface CompressedImageResult {
  sourceFileName: string
  fileName: string
  inputMimeType: string
  outputMimeType: string
  originalBytes: number
  compressedBytes: number
  usedFallback: boolean
  buffer: Buffer
}

export class HttpError extends Error {
  statusCode: number
  code: ApiErrorCode

  constructor(statusCode: number, code: ApiErrorCode, message: string) {
    super(message)
    this.name = 'HttpError'
    this.statusCode = statusCode
    this.code = code
  }

  toPayload(): ApiErrorPayload {
    return {
      error: {
        code: this.code,
        message: this.message
      }
    }
  }
}
