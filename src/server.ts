import multipart from '@fastify/multipart'
import Fastify from 'fastify'
import compressRoutes from './routes/compress.js'
import { HttpError } from './types/api.js'

const port = Number.parseInt(process.env.PORT ?? '3001', 10)
const host = process.env.HOST ?? '0.0.0.0'
const apiToken = process.env.IMAGE_COMPRESS_API_TOKEN?.trim()
const apiBasePath = '/api/image-compress'

if (!apiToken) {
  throw new Error('缺少必填环境变量：IMAGE_COMPRESS_API_TOKEN')
}

const app = Fastify({
  logger: true,
  bodyLimit: 90 * 1024 * 1024
})

app.register(multipart)

app.get('/healthz', async () => {
  return { status: 'ok' }
})

app.get(`${apiBasePath}/healthz`, async () => {
  return { status: 'ok' }
})

app.register(compressRoutes, { apiToken, prefix: apiBasePath })

app.setErrorHandler((error, request, reply) => {
  if (error instanceof HttpError) {
    reply.status(error.statusCode).send(error.toPayload())
    return
  }

  const knownError = error as { code?: string; message?: string }

  if (
    knownError.code === 'FST_REQ_FILE_TOO_LARGE' ||
    knownError.code === 'FST_FILES_LIMIT' ||
    knownError.code === 'FST_FIELDS_LIMIT' ||
    knownError.code === 'FST_PARTS_LIMIT'
  ) {
    const payload = {
      error: {
        code: 'PAYLOAD_TOO_LARGE' as const,
        message: knownError.message ?? 'payload is too large'
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
