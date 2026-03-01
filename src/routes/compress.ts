import type { FastifyPluginAsync } from 'fastify'
import { assertAuthorized } from '../lib/auth.js'
import { compressImages } from '../lib/compress.js'
import {
  MAX_FILE_BYTES,
  MAX_FILE_COUNT,
  MAX_TOTAL_BYTES,
  PROCESSING_CONCURRENCY,
  getDefaultUploadFileName,
  isSupportedInputMimeType,
  normalizeImageMimeType,
  normalizeZipName,
  parseCompressionOptions,
  sanitizeFileName
} from '../lib/validate.js'
import { createZipStream } from '../lib/zip.js'
import { HttpError, type UploadedImage } from '../types/api.js'

interface CompressRoutesOptions {
  apiToken: string
}

const sumBytes = (values: number[]): number => values.reduce((total, value) => total + value, 0)

const normalizeFieldValue = (value: unknown): string => {
  if (typeof value === 'string') {
    return value
  }
  return `${value ?? ''}`
}

const compressRoutes: FastifyPluginAsync<CompressRoutesOptions> = async (app, options) => {
  app.post('/api/v1/compress', async (request, reply) => {
    assertAuthorized(request.headers.authorization, options.apiToken)

    if (!request.isMultipart()) {
      throw new HttpError(400, 'INVALID_ARGUMENT', 'content-type must be multipart/form-data')
    }

    const fields: Record<string, string> = {}
    const files: UploadedImage[] = []
    let totalBytes = 0
    let fileIndex = 0

    const parts = request.parts({
      limits: {
        files: MAX_FILE_COUNT,
        fileSize: MAX_FILE_BYTES,
        fields: 20
      }
    })

    for await (const part of parts) {
      if (part.type === 'file') {
        fileIndex += 1
        const normalizedMimeType = normalizeImageMimeType(part.mimetype)
        if (!isSupportedInputMimeType(normalizedMimeType)) {
          throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'only jpg, png, webp files are allowed')
        }

        const fileBuffer = await part.toBuffer()
        totalBytes += fileBuffer.length
        if (totalBytes > MAX_TOTAL_BYTES) {
          throw new HttpError(413, 'PAYLOAD_TOO_LARGE', `total upload size exceeds ${MAX_TOTAL_BYTES} bytes`)
        }

        const fallbackName = getDefaultUploadFileName(fileIndex, normalizedMimeType)
        const fileName = sanitizeFileName(part.filename ?? '', fallbackName)

        files.push({
          buffer: fileBuffer,
          fileName,
          mimeType: normalizedMimeType,
          byteLength: fileBuffer.length
        })
      } else {
        fields[part.fieldname] = normalizeFieldValue(part.value)
      }
    }

    if (files.length === 0) {
      throw new HttpError(400, 'INVALID_ARGUMENT', 'files is required')
    }

    const optionsFromRequest = parseCompressionOptions(fields)
    const compressedFiles = await compressImages(files, optionsFromRequest, PROCESSING_CONCURRENCY)

    const originalBytes = sumBytes(files.map((file) => file.byteLength))
    const compressedBytes = sumBytes(compressedFiles.map((file) => file.compressedBytes))
    const ratio = originalBytes > 0 ? ((1 - compressedBytes / originalBytes) * 100).toFixed(2) : '0.00'

    reply.header('X-Original-Bytes', String(originalBytes))
    reply.header('X-Compressed-Bytes', String(compressedBytes))
    reply.header('X-Compression-Ratio', ratio)

    const shouldReturnZip = optionsFromRequest.output === 'zip' || compressedFiles.length > 1
    if (!shouldReturnZip) {
      const file = compressedFiles[0]
      if (!file) {
        throw new HttpError(500, 'INTERNAL_ERROR', 'compressed output is empty')
      }
      reply.type(file.outputMimeType)
      reply.header('Content-Disposition', `attachment; filename="${file.fileName}"`)
      return reply.send(file.buffer)
    }

    const zipFileName = normalizeZipName(fields.zipName)
    reply.type('application/zip')
    reply.header('Content-Disposition', `attachment; filename="${zipFileName}"`)

    return reply.send(createZipStream(compressedFiles))
  })
}

export default compressRoutes
