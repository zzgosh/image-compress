import multipart from '@fastify/multipart'
import Fastify from 'fastify'
import { ImageProcessor } from './lib/compress.js'
import { RequestGate } from './lib/request-gate.js'
import { EphemeralResultStore } from './lib/result-store.js'
import { MEGABYTE, formatMegabyteSize } from './lib/size.js'
import { UploadStagingStore } from './lib/upload-staging-store.js'
import {
  DEFAULT_PROCESSING_CONCURRENCY,
  DEFAULT_UPLOAD_MAX_FILE_COUNT,
  DEFAULT_UPLOAD_MAX_FILE_SIZE_BYTES,
  DEFAULT_UPLOAD_MAX_TOTAL_SIZE_BYTES,
  type UploadLimits
} from './lib/validate.js'
import compressRoutes from './routes/compress.js'
import resultRoutes from './routes/results.js'
import { HttpError } from './types/api.js'

const ENV = {
  apiTokens: 'IMAGE_COMPRESS_API_TOKENS',
  host: 'IMAGE_COMPRESS_API_HOST',
  maxActiveRequests: 'IMAGE_COMPRESS_API_MAX_ACTIVE_REQUESTS',
  maxQueuedRequests: 'IMAGE_COMPRESS_API_MAX_QUEUED_REQUESTS',
  port: 'IMAGE_COMPRESS_API_PORT',
  processingConcurrency: 'IMAGE_COMPRESS_API_PROCESSING_CONCURRENCY',
  publicBaseUrl: 'IMAGE_COMPRESS_API_PUBLIC_BASE_URL',
  resultStorageDir: 'IMAGE_COMPRESS_API_RESULT_STORAGE_DIR',
  resultStorageMaxSize: 'IMAGE_COMPRESS_API_RESULT_STORAGE_MAX_SIZE',
  resultTtlSeconds: 'IMAGE_COMPRESS_API_RESULT_TTL_SECONDS',
  uploadStagingDir: 'IMAGE_COMPRESS_API_UPLOAD_STAGING_DIR',
  uploadStagingMaxSize: 'IMAGE_COMPRESS_API_UPLOAD_STAGING_MAX_SIZE',
  uploadMaxFileCount: 'IMAGE_COMPRESS_API_UPLOAD_MAX_FILE_COUNT',
  uploadMaxFileSize: 'IMAGE_COMPRESS_API_UPLOAD_MAX_FILE_SIZE',
  uploadMaxTotalSize: 'IMAGE_COMPRESS_API_UPLOAD_MAX_TOTAL_SIZE'
} as const

const env = process.env
const port = Number.parseInt(env[ENV.port] ?? '3001', 10)
const host = env[ENV.host] ?? '0.0.0.0'
const apiBasePath = '/api/image-compress'
const publicBaseUrl = env[ENV.publicBaseUrl]?.trim()
const MULTIPART_BODY_OVERHEAD_BYTES = 10 * MEGABYTE

const parsePositiveIntegerEnv = (rawValue: string | undefined, defaultValue: number, envName: string): number => {
  if (!rawValue) {
    return defaultValue
  }

  const trimmed = rawValue.trim()
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`环境变量 ${envName} 必须是正整数`)
  }

  const parsed = Number.parseInt(trimmed, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`环境变量 ${envName} 必须是正整数`)
  }

  return parsed
}

const parseNonNegativeIntegerEnv = (rawValue: string | undefined, defaultValue: number, envName: string): number => {
  if (!rawValue) {
    return defaultValue
  }

  const trimmed = rawValue.trim()
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`环境变量 ${envName} 必须是非负整数`)
  }

  const parsed = Number.parseInt(trimmed, 10)
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`环境变量 ${envName} 必须是非负整数`)
  }

  return parsed
}

const assertLegacyEnvIsUnset = (rawValue: string | undefined, legacyEnvName: string, replacementEnvName: string): void => {
  if (rawValue?.trim()) {
    throw new Error(`环境变量 ${legacyEnvName} 已移除，请改用 ${replacementEnvName}`)
  }
}

const parseMegabyteSizeEnv = (rawValue: string | undefined, defaultValue: number, envName: string): number => {
  if (!rawValue) {
    return defaultValue
  }

  const trimmed = rawValue.trim()
  if (/^\d+$/.test(trimmed)) {
    return parsePositiveIntegerEnv(trimmed, defaultValue, envName)
  }

  const matched = trimmed.match(/^(\d+(?:\.\d+)?)\s*MB$/)
  if (!matched?.[1]) {
    throw new Error(`环境变量 ${envName} 必须是正整数（字节）或类似 256MB 的容量值`)
  }

  const value = Number.parseFloat(matched[1])
  const bytes = Math.round(value * MEGABYTE)
  if (!Number.isFinite(bytes) || bytes <= 0) {
    throw new Error(`环境变量 ${envName} 必须大于 0`)
  }

  return bytes
}

const normalizeBaseUrl = (rawValue: string | undefined): string | undefined => {
  if (!rawValue) {
    return undefined
  }

  const trimmed = rawValue.trim()
  if (!trimmed) {
    return undefined
  }

  const url = new URL(trimmed)
  return url.toString().replace(/\/+$/, '')
}

const parseApiTokens = (rawValue: string | undefined): string[] => {
  if (!rawValue) {
    throw new Error(`缺少必填环境变量：${ENV.apiTokens}`)
  }

  const normalizedItems = rawValue.split(',').map((item) => item.trim())
  if (normalizedItems.length === 0 || normalizedItems.some((item) => !item)) {
    throw new Error(`环境变量 ${ENV.apiTokens} 格式错误：请使用逗号分隔的非空 Token 列表`)
  }

  return [...new Set(normalizedItems)]
}

const legacyEnvRenames: Array<[legacyEnvName: string, replacementEnvName: string]> = [
  ['HOST', ENV.host],
  ['MAX_ACTIVE_REQUESTS', ENV.maxActiveRequests],
  ['MAX_QUEUED_REQUESTS', ENV.maxQueuedRequests],
  ['PORT', ENV.port],
  ['PROCESSING_CONCURRENCY', ENV.processingConcurrency],
  ['PUBLIC_BASE_URL', ENV.publicBaseUrl],
  ['RESULT_STORAGE_DIR', ENV.resultStorageDir],
  ['RESULT_STORAGE_MAX_BYTES', ENV.resultStorageMaxSize],
  ['RESULT_STORAGE_MAX_SIZE', ENV.resultStorageMaxSize],
  ['RESULT_TTL_SECONDS', ENV.resultTtlSeconds],
  ['UPLOAD_STAGING_DIR', ENV.uploadStagingDir],
  ['UPLOAD_STAGING_MAX_SIZE', ENV.uploadStagingMaxSize],
  ['UPLOAD_MAX_FILE_COUNT', ENV.uploadMaxFileCount],
  ['UPLOAD_MAX_FILE_SIZE', ENV.uploadMaxFileSize],
  ['UPLOAD_MAX_TOTAL_SIZE', ENV.uploadMaxTotalSize]
]

for (const [legacyEnvName, replacementEnvName] of legacyEnvRenames) {
  assertLegacyEnvIsUnset(env[legacyEnvName], legacyEnvName, replacementEnvName)
}

const apiTokens = parseApiTokens(env[ENV.apiTokens])

const uploadLimits: UploadLimits = {
  maxFileCount: parsePositiveIntegerEnv(env[ENV.uploadMaxFileCount], DEFAULT_UPLOAD_MAX_FILE_COUNT, ENV.uploadMaxFileCount),
  maxFileSizeBytes: parseMegabyteSizeEnv(
    env[ENV.uploadMaxFileSize],
    DEFAULT_UPLOAD_MAX_FILE_SIZE_BYTES,
    ENV.uploadMaxFileSize
  ),
  maxTotalSizeBytes: parseMegabyteSizeEnv(
    env[ENV.uploadMaxTotalSize],
    DEFAULT_UPLOAD_MAX_TOTAL_SIZE_BYTES,
    ENV.uploadMaxTotalSize
  )
}

if (uploadLimits.maxTotalSizeBytes < uploadLimits.maxFileSizeBytes) {
  throw new Error(`环境变量 ${ENV.uploadMaxTotalSize} 不能小于 ${ENV.uploadMaxFileSize}`)
}

const resultTtlMs = parsePositiveIntegerEnv(env[ENV.resultTtlSeconds], 300, ENV.resultTtlSeconds) * 1000
const processingConcurrency = parsePositiveIntegerEnv(
  env[ENV.processingConcurrency],
  DEFAULT_PROCESSING_CONCURRENCY,
  ENV.processingConcurrency
)
const maxActiveRequests = parseNonNegativeIntegerEnv(env[ENV.maxActiveRequests], 0, ENV.maxActiveRequests)
const maxQueuedRequests = parseNonNegativeIntegerEnv(env[ENV.maxQueuedRequests], 0, ENV.maxQueuedRequests)
const resultStorageMaxBytes = parseMegabyteSizeEnv(env[ENV.resultStorageMaxSize], 256 * MEGABYTE, ENV.resultStorageMaxSize)
const resultStorageDir = env[ENV.resultStorageDir]?.trim() || undefined
const uploadStagingDir = env[ENV.uploadStagingDir]?.trim() || undefined
const uploadStagingMaxBytes =
  env[ENV.uploadStagingMaxSize]?.trim() ? parseMegabyteSizeEnv(env[ENV.uploadStagingMaxSize], 0, ENV.uploadStagingMaxSize) : undefined
const normalizedPublicBaseUrl = normalizeBaseUrl(publicBaseUrl)
const bodyLimit = uploadLimits.maxTotalSizeBytes + MULTIPART_BODY_OVERHEAD_BYTES

if (maxActiveRequests === 0 && maxQueuedRequests > 0) {
  throw new Error(`环境变量 ${ENV.maxQueuedRequests} 需要配合 ${ENV.maxActiveRequests} 一起使用`)
}

const app = Fastify({
  logger: true,
  bodyLimit
})
const imageProcessor = new ImageProcessor(processingConcurrency)
const requestGate = new RequestGate({
  maxActiveRequests,
  maxQueuedRequests
})
const resultStore = new EphemeralResultStore({
  ttlMs: resultTtlMs,
  maxTotalBytes: resultStorageMaxBytes,
  storageDir: resultStorageDir
})
const uploadStagingStore = new UploadStagingStore({
  storageDir: uploadStagingDir,
  maxTotalBytes: uploadStagingMaxBytes
})

app.register(multipart)

app.get('/healthz', async () => {
  return { status: 'ok' }
})

app.get(`${apiBasePath}/healthz`, async () => {
  return { status: 'ok' }
})

app.register(compressRoutes, {
  apiTokens,
  apiBasePath,
  imageProcessor,
  publicBaseUrl: normalizedPublicBaseUrl,
  requestGate,
  resultStore,
  uploadLimits,
  uploadStagingStore,
  prefix: apiBasePath
})
app.register(resultRoutes, { resultStore, prefix: apiBasePath })

app.addHook('onClose', async () => {
  await resultStore.close()
  await uploadStagingStore.close()
})

app.setErrorHandler((error, request, reply) => {
  if (error instanceof HttpError) {
    if (error.headers) {
      for (const [headerName, headerValue] of Object.entries(error.headers)) {
        reply.header(headerName, headerValue)
      }
    }
    reply.status(error.statusCode).send(error.toPayload())
    return
  }

  const knownError = error as { code?: string; message?: string }

  if (
    knownError.code === 'FST_ERR_CTP_BODY_TOO_LARGE' ||
    knownError.code === 'FST_REQ_FILE_TOO_LARGE' ||
    knownError.code === 'FST_FILES_LIMIT' ||
    knownError.code === 'FST_FIELDS_LIMIT' ||
    knownError.code === 'FST_PARTS_LIMIT'
  ) {
    let message = knownError.message ?? 'payload is too large'

    if (knownError.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      message = `request body exceeds ${formatMegabyteSize(bodyLimit)}`
    } else if (knownError.code === 'FST_REQ_FILE_TOO_LARGE') {
      message = `single file size exceeds ${formatMegabyteSize(uploadLimits.maxFileSizeBytes)}`
    } else if (knownError.code === 'FST_FILES_LIMIT') {
      message = `file count exceeds ${uploadLimits.maxFileCount}`
    }

    const payload = {
      error: {
        code: 'PAYLOAD_TOO_LARGE' as const,
        message
      }
    }
    reply.status(413).send(payload)
    return
  }

  request.log.error({ err: error }, 'unhandled request error')
  reply.status(500).send({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'internal server error'
    }
  })
})

const start = async (): Promise<void> => {
  try {
    await resultStore.init()
    await uploadStagingStore.init()
    await app.listen({ port, host })

    let isClosing = false
    const close = async (signal: NodeJS.Signals): Promise<void> => {
      if (isClosing) return
      isClosing = true

      app.log.info({ signal }, 'received shutdown signal')
      try {
        await app.close()
        process.exit(0)
      } catch (error) {
        app.log.error(error, 'failed to close server')
        process.exit(1)
      }
    }

    process.on('SIGINT', () => void close('SIGINT'))
    process.on('SIGTERM', () => void close('SIGTERM'))
  } catch (error) {
    app.log.error(error, 'failed to start service')
    process.exit(1)
  }
}

void start()
