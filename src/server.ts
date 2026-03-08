import multipart from '@fastify/multipart'
import Fastify from 'fastify'
import { EphemeralResultStore } from './lib/result-store.js'
import { MEGABYTE, formatMegabyteSize } from './lib/size.js'
import {
  DEFAULT_UPLOAD_MAX_FILE_COUNT,
  DEFAULT_UPLOAD_MAX_FILE_SIZE_BYTES,
  DEFAULT_UPLOAD_MAX_TOTAL_SIZE_BYTES,
  type UploadLimits
} from './lib/validate.js'
import compressRoutes from './routes/compress.js'
import resultRoutes from './routes/results.js'
import { HttpError } from './types/api.js'

const port = Number.parseInt(process.env.PORT ?? '3001', 10)
const host = process.env.HOST ?? '0.0.0.0'
const apiBasePath = '/api/image-compress'
const publicBaseUrl = process.env.PUBLIC_BASE_URL?.trim()
const MULTIPART_BODY_OVERHEAD_BYTES = 10 * MEGABYTE

const parsePositiveIntegerEnv = (rawValue: string | undefined, defaultValue: number, envName: string): number => {
  if (!rawValue) {
    return defaultValue
  }

  const parsed = Number.parseInt(rawValue, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`环境变量 ${envName} 必须是正整数`)
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
    throw new Error('缺少必填环境变量：IMAGE_COMPRESS_API_TOKENS')
  }

  const normalizedItems = rawValue.split(',').map((item) => item.trim())
  if (normalizedItems.length === 0 || normalizedItems.some((item) => !item)) {
    throw new Error('环境变量 IMAGE_COMPRESS_API_TOKENS 格式错误：请使用逗号分隔的非空 Token 列表')
  }

  return [...new Set(normalizedItems)]
}

const apiTokens = parseApiTokens(process.env.IMAGE_COMPRESS_API_TOKENS)
assertLegacyEnvIsUnset(process.env.RESULT_STORAGE_MAX_BYTES, 'RESULT_STORAGE_MAX_BYTES', 'RESULT_STORAGE_MAX_SIZE')

const uploadLimits: UploadLimits = {
  maxFileCount: parsePositiveIntegerEnv(process.env.UPLOAD_MAX_FILE_COUNT, DEFAULT_UPLOAD_MAX_FILE_COUNT, 'UPLOAD_MAX_FILE_COUNT'),
  maxFileSizeBytes: parseMegabyteSizeEnv(
    process.env.UPLOAD_MAX_FILE_SIZE,
    DEFAULT_UPLOAD_MAX_FILE_SIZE_BYTES,
    'UPLOAD_MAX_FILE_SIZE'
  ),
  maxTotalSizeBytes: parseMegabyteSizeEnv(
    process.env.UPLOAD_MAX_TOTAL_SIZE,
    DEFAULT_UPLOAD_MAX_TOTAL_SIZE_BYTES,
    'UPLOAD_MAX_TOTAL_SIZE'
  )
}

if (uploadLimits.maxTotalSizeBytes < uploadLimits.maxFileSizeBytes) {
  throw new Error('环境变量 UPLOAD_MAX_TOTAL_SIZE 不能小于 UPLOAD_MAX_FILE_SIZE')
}

const resultTtlMs = parsePositiveIntegerEnv(process.env.RESULT_TTL_SECONDS, 300, 'RESULT_TTL_SECONDS') * 1000
const resultStorageMaxBytes = parseMegabyteSizeEnv(process.env.RESULT_STORAGE_MAX_SIZE, 256 * MEGABYTE, 'RESULT_STORAGE_MAX_SIZE')
const resultStorageDir = process.env.RESULT_STORAGE_DIR?.trim() || undefined
const normalizedPublicBaseUrl = normalizeBaseUrl(publicBaseUrl)
const bodyLimit = uploadLimits.maxTotalSizeBytes + MULTIPART_BODY_OVERHEAD_BYTES

const app = Fastify({
  logger: true,
  bodyLimit
})
const resultStore = new EphemeralResultStore({
  ttlMs: resultTtlMs,
  maxTotalBytes: resultStorageMaxBytes,
  storageDir: resultStorageDir
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
  publicBaseUrl: normalizedPublicBaseUrl,
  resultStore,
  uploadLimits,
  prefix: apiBasePath
})
app.register(resultRoutes, { resultStore, prefix: apiBasePath })

app.addHook('onClose', async () => {
  await resultStore.close()
})

app.setErrorHandler((error, request, reply) => {
  if (error instanceof HttpError) {
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
