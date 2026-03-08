import type { FastifyPluginAsync } from 'fastify'
import { EphemeralResultStore } from '../lib/result-store.js'
import { buildAttachmentContentDisposition } from '../lib/validate.js'

interface ResultRoutesOptions {
  resultStore: EphemeralResultStore
}

const resultRoutes: FastifyPluginAsync<ResultRoutesOptions> = async (app, options) => {
  app.get<{ Params: { resultId: string }; Querystring: { token?: string } }>('/v1/results/:resultId', async (request, reply) => {
    const claimed = await options.resultStore.claim(request.params.resultId, request.query.token)

    reply.type(claimed.mimeType)
    reply.header('Content-Disposition', buildAttachmentContentDisposition(claimed.fileName))
    reply.header('Content-Length', String(claimed.byteLength))
    reply.header('Cache-Control', 'no-store')

    let settled = false
    const settle = async (mode: 'completed' | 'aborted'): Promise<void> => {
      if (settled) return
      settled = true

      try {
        if (mode === 'completed') {
          await claimed.markCompleted()
          return
        }

        await claimed.markAborted()
      } catch (error) {
        request.log.error({ err: error, resultId: request.params.resultId, mode }, 'failed to settle result download')
      }
    }

    claimed.stream.once('error', (error) => {
      void settle('aborted')
      reply.raw.destroy(error)
    })

    reply.raw.once('finish', () => {
      void settle('completed')
    })
    reply.raw.once('close', () => {
      if (!reply.raw.writableFinished) {
        void settle('aborted')
      }
    })

    return reply.send(claimed.stream)
  })
}

export default resultRoutes
