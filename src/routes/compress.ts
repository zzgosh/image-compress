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
import { createZipStream, withUniqueZipEntryNames } from '../lib/zip.js'
import { HttpError, type CompressedImageResult, type UploadedImage } from '../types/api.js'

interface CompressRoutesOptions {
  apiTokens: string[]
}

type ResponseMode = 'metadata' | 'binary'
type CompressOutcome = 'compressed' | 'fallback_original'
type CompressReason = 'reencoded_not_smaller'

const sumBytes = (values: number[]): number => values.reduce((total, value) => total + value, 0)

const normalizeFieldValue = (value: unknown): string => {
  if (typeof value === 'string') {
    return value
  }
  return `${value ?? ''}`
}

const parseResponseMode = (rawValue: string | undefined): ResponseMode | undefined => {
  if (!rawValue) return undefined

  const normalized = rawValue.trim().toLowerCase()
  if (normalized === 'metadata' || normalized === 'binary') {
    return normalized
  }

  throw new HttpError(400, 'INVALID_ARGUMENT', 'responseMode must be metadata or binary')
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

const resolveFileOutcome = (
  file: CompressedImageResult
): { compressed: boolean; outcome: CompressOutcome; reason?: CompressReason } => {
  const compressed = !file.usedFallback
  return {
    compressed,
    outcome: compressed ? 'compressed' : 'fallback_original',
    reason: compressed ? undefined : 'reencoded_not_smaller'
  }
}

const resolveResponseOutcome = (
  files: CompressedImageResult[]
): { compressed: boolean; outcome: CompressOutcome; reason?: CompressReason } => {
  const compressed = files.some((file) => !file.usedFallback)
  return {
    compressed,
    outcome: compressed ? 'compressed' : 'fallback_original',
    reason: compressed ? undefined : 'reencoded_not_smaller'
  }
}

const compressRoutes: FastifyPluginAsync<CompressRoutesOptions> = async (app, options) => {
  app.post<{ Querystring: { responseMode?: string } }>('/v1/compress', async (request, reply) => {
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

        if (part.fieldname === 'responseMode') {
          fields.responseMode = value
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

    const responseModeFromQuery = parseResponseMode(request.query.responseMode)
    const responseModeFromForm = parseResponseMode(fields.responseMode)
    if (responseModeFromQuery && responseModeFromForm && responseModeFromQuery !== responseModeFromForm) {
      throw new HttpError(400, 'INVALID_ARGUMENT', 'responseMode in query and form must match')
    }
    const responseMode: ResponseMode = responseModeFromQuery ?? responseModeFromForm ?? 'metadata'

    const compressedFiles = await compressImages(files)
    const outputFiles = compressedFiles.length === 1 ? compressedFiles : withUniqueZipEntryNames(compressedFiles)

    const originalBytes = sumBytes(files.map((file) => file.byteLength))
    const outputBytes = sumBytes(compressedFiles.map((file) => file.compressedBytes))
    const savedBytes = originalBytes - outputBytes
    const ratio = originalBytes > 0 ? ((savedBytes / originalBytes) * 100).toFixed(2) : '0.00'
    const compressionRatio = originalBytes > 0 ? savedBytes / originalBytes : 0

    const { compressed, outcome, reason } = resolveResponseOutcome(compressedFiles)

    if (responseMode === 'metadata') {
      const outputType = outputFiles.length === 1 ? ('single' as const) : ('zip' as const)
      const outputMimeType = outputType === 'single' ? outputFiles[0]?.outputMimeType : 'application/zip'
      const outputFileName = outputType === 'single' ? outputFiles[0]?.fileName : normalizeZipName(fields.zipName)

      if (outputType === 'single' && (!outputMimeType || !outputFileName)) {
        throw new HttpError(500, 'INTERNAL_ERROR', 'compressed output is empty')
      }

      return reply.send({
        success: true,
        compressed,
        outcome,
        reason,
        originalBytes,
        outputBytes,
        savedBytes,
        compressionRatio,
        outputType,
        outputMimeType,
        outputFileName,
        fileCount: files.length,
        results: outputFiles.map((file) => {
          const { compressed: fileCompressed, outcome: fileOutcome, reason: fileReason } = resolveFileOutcome(file)
          const fileSavedBytes = file.originalBytes - file.compressedBytes
          const fileCompressionRatio = file.originalBytes > 0 ? fileSavedBytes / file.originalBytes : 0

          return {
            originalFileName: file.sourceFileName,
            outputFileName: file.fileName,
            outputMimeType: file.outputMimeType,
            compressed: fileCompressed,
            outcome: fileOutcome,
            reason: fileReason,
            originalBytes: file.originalBytes,
            outputBytes: file.compressedBytes,
            savedBytes: fileSavedBytes,
            compressionRatio: fileCompressionRatio
          }
        })
      })
    }

    reply.header('X-Original-Bytes', String(originalBytes))
    reply.header('X-Compressed-Bytes', String(outputBytes))
    reply.header('X-Compression-Ratio', ratio)
    reply.header('X-Compressed', String(compressed))
    reply.header('X-Outcome', outcome)

    if (outputFiles.length === 1) {
      const file = outputFiles[0]
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

    return reply.send(createZipStream(outputFiles))
  })
}

export default compressRoutes
