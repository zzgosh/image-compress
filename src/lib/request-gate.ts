import { HttpError } from '../types/api.js'

export interface RequestGateOptions {
  maxActiveRequests: number
  maxQueuedRequests: number
  retryAfterSeconds?: number
}

export interface RequestPermit {
  release: () => void
}

type QueueEntry = {
  resolve: (permit: RequestPermit) => void
  reject: (error: unknown) => void
  cleanupAbortListener?: () => void
}

const DEFAULT_RETRY_AFTER_SECONDS = 5

const buildBusyError = (retryAfterSeconds: number): HttpError =>
  new HttpError(503, 'SERVICE_UNAVAILABLE', 'server is busy, retry later', {
    headers: {
      'Retry-After': String(retryAfterSeconds)
    }
  })

export class RequestGate {
  private readonly maxActiveRequests: number
  private readonly maxQueuedRequests: number
  private readonly retryAfterSeconds: number
  private activeRequests = 0
  private readonly queue: QueueEntry[] = []

  constructor(options: RequestGateOptions) {
    this.maxActiveRequests = options.maxActiveRequests
    this.maxQueuedRequests = options.maxQueuedRequests
    this.retryAfterSeconds = options.retryAfterSeconds ?? DEFAULT_RETRY_AFTER_SECONDS
  }

  async acquire(signal?: AbortSignal): Promise<RequestPermit> {
    if (this.maxActiveRequests <= 0) {
      return { release: () => undefined }
    }

    if (this.activeRequests < this.maxActiveRequests) {
      this.activeRequests += 1
      return this.createPermit()
    }

    if (this.queue.length >= this.maxQueuedRequests) {
      throw buildBusyError(this.retryAfterSeconds)
    }

    return new Promise<RequestPermit>((resolve, reject) => {
      const queueEntry: QueueEntry = {
        resolve,
        reject
      }

      if (signal) {
        const abortHandler = (): void => {
          const index = this.queue.indexOf(queueEntry)
          if (index >= 0) {
            this.queue.splice(index, 1)
          }

          signal.removeEventListener('abort', abortHandler)
          reject(new Error('request aborted while waiting for capacity'))
        }

        if (signal.aborted) {
          abortHandler()
          return
        }

        queueEntry.cleanupAbortListener = () => {
          signal.removeEventListener('abort', abortHandler)
        }
        signal.addEventListener('abort', abortHandler, { once: true })
      }

      this.queue.push(queueEntry)
    })
  }

  private createPermit(): RequestPermit {
    let released = false

    return {
      release: () => {
        if (released) {
          return
        }
        released = true

        while (this.queue.length > 0) {
          const next = this.queue.shift()
          if (!next) {
            break
          }

          next.cleanupAbortListener?.()
          next.resolve(this.createPermit())
          return
        }

        this.activeRequests = Math.max(0, this.activeRequests - 1)
      }
    }
  }
}
