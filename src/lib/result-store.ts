import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createReadStream, promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { ReadStream } from 'node:fs'
import type { CompressedImageResult } from '../types/api.js'
import { HttpError } from '../types/api.js'
import { formatMegabyteSize } from './size.js'
import { createZipFile } from './zip.js'

type ResultArtifactInput =
  | {
      type: 'single'
      fileName: string
      mimeType: string
      buffer: Buffer
    }
  | {
      type: 'zip'
      fileName: string
      mimeType: 'application/zip'
      files: CompressedImageResult[]
    }

type StoredResult = {
  id: string
  token: string
  fileName: string
  mimeType: string
  filePath: string
  byteLength: number
  expiresAt: number
  downloading: boolean
}

export interface ResultStoreOptions {
  storageDir?: string
  ttlMs: number
  maxTotalBytes: number
  cleanupIntervalMs?: number
  now?: () => number
}

export interface CreatedResult {
  id: string
  token: string
  expiresAt: string
}

export interface ClaimedResult {
  fileName: string
  mimeType: string
  byteLength: number
  stream: ReadStream
  markCompleted: () => Promise<void>
  markAborted: () => Promise<void>
}

const DEFAULT_STORAGE_DIR = path.join(tmpdir(), 'image-compress-api-results')
const DEFAULT_CLEANUP_INTERVAL_MS = 30_000

const safeTokenEqual = (provided: string, expected: string): boolean => {
  const providedBuffer = Buffer.from(provided)
  const expectedBuffer = Buffer.from(expected)

  if (providedBuffer.length !== expectedBuffer.length) {
    return false
  }

  return timingSafeEqual(providedBuffer, expectedBuffer)
}

const resultNotFound = (): HttpError => new HttpError(404, 'NOT_FOUND', 'result not found')

export class EphemeralResultStore {
  private readonly entries = new Map<string, StoredResult>()
  private readonly storageDir: string
  private readonly ttlMs: number
  private readonly maxTotalBytes: number
  private readonly now: () => number
  private readonly cleanupIntervalMs: number
  private cleanupTimer?: NodeJS.Timeout
  private totalBytes = 0

  constructor(options: ResultStoreOptions) {
    this.storageDir = options.storageDir ?? DEFAULT_STORAGE_DIR
    this.ttlMs = options.ttlMs
    this.maxTotalBytes = options.maxTotalBytes
    this.now = options.now ?? (() => Date.now())
    this.cleanupIntervalMs = options.cleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS
  }

  async init(): Promise<void> {
    await fs.rm(this.storageDir, { recursive: true, force: true })
    await fs.mkdir(this.storageDir, { recursive: true })

    this.cleanupTimer = setInterval(() => {
      void this.sweepExpired()
    }, this.cleanupIntervalMs)
    this.cleanupTimer.unref()
  }

  async close(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = undefined
    }

    this.entries.clear()
    this.totalBytes = 0
    await fs.rm(this.storageDir, { recursive: true, force: true })
  }

  async create(input: ResultArtifactInput): Promise<CreatedResult> {
    await this.sweepExpired()

    const id = randomUUID()
    const token = randomBytes(24).toString('base64url')
    const finalPath = path.join(this.storageDir, `${id}.bin`)
    const tempPath = path.join(this.storageDir, `${id}.tmp`)

    let byteLength = 0

    try {
      if (input.type === 'single') {
        byteLength = input.buffer.length
        this.assertStorageCapacity(byteLength)
        await fs.writeFile(tempPath, input.buffer)
      } else {
        await createZipFile(input.files, tempPath)
        const stats = await fs.stat(tempPath)
        byteLength = stats.size
        this.assertStorageCapacity(byteLength)
      }

      await fs.rename(tempPath, finalPath)

      const expiresAt = this.now() + this.ttlMs
      this.entries.set(id, {
        id,
        token,
        fileName: input.fileName,
        mimeType: input.mimeType,
        filePath: finalPath,
        byteLength,
        expiresAt,
        downloading: false
      })
      this.totalBytes += byteLength

      return {
        id,
        token,
        expiresAt: new Date(expiresAt).toISOString()
      }
    } catch (error) {
      await fs.rm(tempPath, { force: true })
      await fs.rm(finalPath, { force: true })
      throw error
    }
  }

  async claim(id: string, token: string | undefined): Promise<ClaimedResult> {
    await this.sweepExpired()

    if (!token) {
      throw resultNotFound()
    }

    const entry = this.entries.get(id)
    if (!entry || entry.downloading || !safeTokenEqual(token, entry.token)) {
      throw resultNotFound()
    }

    entry.downloading = true
    const stream = createReadStream(entry.filePath)

    return {
      fileName: entry.fileName,
      mimeType: entry.mimeType,
      byteLength: entry.byteLength,
      stream,
      markCompleted: async () => {
        const current = this.entries.get(id)
        if (!current) return
        await this.deleteEntry(current)
      },
      markAborted: async () => {
        const current = this.entries.get(id)
        if (!current) return

        if (current.expiresAt <= this.now()) {
          await this.deleteEntry(current)
          return
        }

        current.downloading = false
      }
    }
  }

  private assertStorageCapacity(nextBytes: number): void {
    if (this.totalBytes + nextBytes > this.maxTotalBytes) {
      throw new HttpError(
        507,
        'INSUFFICIENT_STORAGE',
        `temporary result storage limit reached (${formatMegabyteSize(this.maxTotalBytes)})`
      )
    }
  }

  private async sweepExpired(): Promise<void> {
    const now = this.now()
    const expiredEntries = [...this.entries.values()].filter((entry) => !entry.downloading && entry.expiresAt <= now)

    for (const entry of expiredEntries) {
      await this.deleteEntry(entry)
    }
  }

  private async deleteEntry(entry: StoredResult): Promise<void> {
    const existing = this.entries.get(entry.id)
    if (!existing) return

    this.entries.delete(entry.id)
    this.totalBytes = Math.max(0, this.totalBytes - entry.byteLength)

    try {
      await fs.unlink(entry.filePath)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code
      if (code !== 'ENOENT') {
        throw error
      }
    }
  }
}
