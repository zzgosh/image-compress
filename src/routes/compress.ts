import type { FastifyPluginAsync } from 'fastify'
import { assertAuthorized } from '../lib/auth.js'
import { compressImages } from '../lib/compress.js'
import { EphemeralResultStore } from '../lib/result-store.js'
import { formatMegabyteSize } from '../lib/size.js'
import {
  normalizeZipName,
  sanitizeFileName,
  type UploadLimits
} from '../lib/validate.js'
import { withUniqueZipEntryNames } from '../lib/zip.js'
import { HttpError, type CompressedImageResult, type UploadedImage } from '../types/api.js'

interface CompressRoutesOptions {
  apiTokens: string[]
  apiBasePath: string
  publicBaseUrl?: string
  resultStore: EphemeralResultStore
  uploadLimits: UploadLimits
}

type CompressOutcome = 'compressed' | 'fallback_original'
type CompressReason = 'reencoded_not_smaller'

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

const buildRequestOrigin = (
  requestHost: string | undefined,
  forwardedHost: string | undefined,
  forwardedProto: string | undefined
): string => {
  const host = forwardedHost?.split(',')[0]?.trim() || requestHost
  if (!host) {
    throw new HttpError(500, 'INTERNAL_ERROR', 'failed to determine request host for download url')
  }

  const protocol = forwardedProto?.split(',')[0]?.trim() || 'http'
  return `${protocol}://${host}`
}

const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, '')

const buildDownloadUrl = (
  requestHost: string | undefined,
  forwardedHost: string | undefined,
  forwardedProto: string | undefined,
  configuredBaseUrl: string | undefined,
  apiBasePath: string,
  resultId: string,
  token: string
): string => {
  const baseUrl = trimTrailingSlash(configuredBaseUrl ?? buildRequestOrigin(requestHost, forwardedHost, forwardedProto))
  const path = `${apiBasePath}/v1/results/${resultId}?token=${encodeURIComponent(token)}`
  return `${baseUrl}${path}`
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

    if (request.query.responseMode) {
      throw new HttpError(400, 'INVALID_ARGUMENT', 'responseMode is no longer supported; use the JSON download flow')
    }

    const fields: Record<string, string> = {}
    const files: UploadedImage[] = []
    let totalBytes = 0
    let fileIndex = 0
    let firstError: HttpError | undefined

    const parts = request.parts({
      limits: {
        files: options.uploadLimits.maxFileCount,
        fileSize: options.uploadLimits.maxFileSizeBytes,
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
        if (totalBytes > options.uploadLimits.maxTotalSizeBytes) {
          firstError ??= new HttpError(
            413,
            'PAYLOAD_TOO_LARGE',
            `total upload size exceeds ${formatMegabyteSize(options.uploadLimits.maxTotalSizeBytes)}`
          )
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
          firstError ??= new HttpError(400, 'INVALID_ARGUMENT', 'responseMode is no longer supported; use the JSON download flow')
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
    const outputFiles = compressedFiles.length === 1 ? compressedFiles : withUniqueZipEntryNames(compressedFiles)

    const originalBytes = sumBytes(files.map((file) => file.byteLength))
    const outputBytes = sumBytes(compressedFiles.map((file) => file.compressedBytes))
    const savedBytes = originalBytes - outputBytes
    const compressionRatio = originalBytes > 0 ? savedBytes / originalBytes : 0

    const { compressed, outcome, reason } = resolveResponseOutcome(compressedFiles)
    const outputType = outputFiles.length === 1 ? ('single' as const) : ('zip' as const)
    const singleOutputFile = outputType === 'single' ? outputFiles[0] : undefined
    let outputMimeType: string
    let outputFileName: string

    let storedResult
    if (outputType === 'single') {
      if (!singleOutputFile) {
        throw new HttpError(500, 'INTERNAL_ERROR', 'compressed output is empty')
      }

      outputMimeType = singleOutputFile.outputMimeType
      outputFileName = singleOutputFile.fileName
      storedResult = await options.resultStore.create({
        type: 'single',
        fileName: outputFileName,
        mimeType: outputMimeType,
        buffer: singleOutputFile.buffer
      })
    } else {
      outputMimeType = 'application/zip'
      outputFileName = normalizeZipName(fields.zipName)
      storedResult = await options.resultStore.create({
        type: 'zip',
        fileName: outputFileName,
        mimeType: 'application/zip',
        files: outputFiles
      })
    }

    const downloadUrl = buildDownloadUrl(
      request.headers.host,
      Array.isArray(request.headers['x-forwarded-host']) ? request.headers['x-forwarded-host'][0] : request.headers['x-forwarded-host'],
      Array.isArray(request.headers['x-forwarded-proto']) ? request.headers['x-forwarded-proto'][0] : request.headers['x-forwarded-proto'],
      options.publicBaseUrl,
      options.apiBasePath,
      storedResult.id,
      storedResult.token
    )

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
      download: {
        url: downloadUrl,
        expiresAt: storedResult.expiresAt,
        singleUse: true
      },
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
  })
}

export default compressRoutes
