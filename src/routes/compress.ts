import type { FastifyPluginAsync } from 'fastify'
import { assertAuthorized } from '../lib/auth.js'
import { compressImages } from '../lib/compress.js'
import {
  MAX_FILE_BYTES,
  MAX_FILE_COUNT,
  MAX_TOTAL_BYTES,
  normalizeZipName,
  sanitizeFileName
} from '../lib/validate.js'
import { createZipStream } from '../lib/zip.js'
import { HttpError, type UploadedImage } from '../types/api.js'

interface CompressRoutesOptions {
  apiTokens: string[]
}

const sumBytes = (values: number[]): number => values.reduce((total, value) => total + value, 0)

const normalizeFieldValue = (value: unknown): string => {
  if (typeof value === 'string') {
    return value
  }
  return `${value ?? ''}`
}

const drainReadable = async (stream: NodeJS.ReadableStream): Promise<void> => {
  try {
    for await (const _ of stream) {
      // discard
    }
  } catch {
    // best-effort drain, ignore errors here
  }
}

const compressRoutes: FastifyPluginAsync<CompressRoutesOptions> = async (app, options) => {
  app.post('/v1/compress', async (request, reply) => {
    assertAuthorized(request.headers.authorization, options.apiTokens)

    if (!request.isMultipart()) {
      throw new HttpError(400, 'INVALID_ARGUMENT', 'content-type must be multipart/form-data')
    }

    const fields: Record<string, string> = {}
    const files: UploadedImage[] = []
    let totalBytes = 0
    let fileIndex = 0
    let firstError: HttpError | undefined

    const parts = request.parts({
      limits: {
        files: MAX_FILE_COUNT,
        fileSize: MAX_FILE_BYTES,
        fields: 20
      }
    })

    for await (const part of parts) {
      if (part.type === 'file') {
        // 如果已经判定请求无效，继续把 multipart 流读完，避免请求悬挂。
        if (firstError) {
          await drainReadable(part.file)
          continue
        }

        if (part.fieldname !== 'files') {
          firstError ??= new HttpError(400, 'INVALID_ARGUMENT', 'file field name must be files')
          await drainReadable(part.file)
          continue
        }

        const fileBuffer = await part.toBuffer()
        totalBytes += fileBuffer.length
        if (totalBytes > MAX_TOTAL_BYTES) {
          firstError ??= new HttpError(413, 'PAYLOAD_TOO_LARGE', `total upload size exceeds ${MAX_TOTAL_BYTES} bytes`)
          continue
        }

        fileIndex += 1
        const fallbackName = `image_${fileIndex}`
        const fileName = sanitizeFileName(part.filename ?? '', fallbackName)

        files.push({
          buffer: fileBuffer,
          fileName,
          byteLength: fileBuffer.length
        })
      } else {
        const value = normalizeFieldValue(part.value)

        if (part.fieldname === 'zipName') {
          fields.zipName = value
          continue
        }

        if (part.fieldname === 'quality' || part.fieldname === 'targetFormat' || part.fieldname === 'output') {
          firstError ??= new HttpError(400, 'INVALID_ARGUMENT', 'quality/targetFormat/output are not supported')
          continue
        }

        firstError ??= new HttpError(400, 'INVALID_ARGUMENT', `unsupported field: ${part.fieldname}`)
      }
    }

    if (firstError) {
      throw firstError
    }

    if (files.length === 0) {
      throw new HttpError(400, 'INVALID_ARGUMENT', 'files is required')
    }

    const compressedFiles = await compressImages(files)

    const originalBytes = sumBytes(files.map((file) => file.byteLength))
    const compressedBytes = sumBytes(compressedFiles.map((file) => file.compressedBytes))
    const ratio = originalBytes > 0 ? ((1 - compressedBytes / originalBytes) * 100).toFixed(2) : '0.00'

    reply.header('X-Original-Bytes', String(originalBytes))
    reply.header('X-Compressed-Bytes', String(compressedBytes))
    reply.header('X-Compression-Ratio', ratio)

    if (compressedFiles.length === 1) {
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
