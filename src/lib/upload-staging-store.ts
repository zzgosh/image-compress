import { randomUUID } from 'node:crypto'
import { createWriteStream, promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Transform, type Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { HttpError } from '../types/api.js'
import { formatMegabyteSize } from './size.js'

export interface UploadStagingStoreOptions {
  storageDir?: string
  maxTotalBytes?: number
}

export interface StagedUpload {
  filePath: string
  byteLength: number
  cleanup: () => Promise<void>
}

type StoredUpload = {
  filePath: string
  byteLength: number
}

const DEFAULT_STORAGE_DIR = path.join(tmpdir(), 'image-compress-api-upload-staging')
const STORE_MARKER_FILE_NAME = '.image-compress-upload-staging'
const MANAGED_UPLOAD_FILE_PATTERN = /^upload-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/i

const buildStorageLimitError = (maxTotalBytes: number): HttpError =>
  new HttpError(
    507,
    'INSUFFICIENT_STORAGE',
    `temporary upload staging storage limit reached (${formatMegabyteSize(maxTotalBytes)})`
  )

const getChunkByteLength = (chunk: unknown): number => {
  if (Buffer.isBuffer(chunk)) {
    return chunk.length
  }

  if (typeof chunk === 'string') {
    return Buffer.byteLength(chunk)
  }

  return Buffer.byteLength(String(chunk ?? ''))
}

export class UploadStagingStore {
  private readonly storageDir: string
  private readonly maxTotalBytes?: number
  private readonly entries = new Map<string, StoredUpload>()
  private totalBytes = 0

  constructor(options: UploadStagingStoreOptions) {
    this.storageDir = options.storageDir ?? DEFAULT_STORAGE_DIR
    this.maxTotalBytes = options.maxTotalBytes
  }

  async init(): Promise<void> {
    await fs.mkdir(this.storageDir, { recursive: true })
    await fs.writeFile(path.join(this.storageDir, STORE_MARKER_FILE_NAME), 'image-compress-upload-staging\n')
    this.entries.clear()
    this.totalBytes = 0
    await this.removeManagedArtifacts()
  }

  async close(): Promise<void> {
    const activeEntries = [...this.entries.entries()]
    await Promise.allSettled(activeEntries.map(async ([id]) => this.release(id)))
    this.entries.clear()
    this.totalBytes = 0
    await this.removeManagedArtifacts()
  }

  async stage(stream: Readable): Promise<StagedUpload> {
    const id = randomUUID()
    const filePath = path.join(this.storageDir, `upload-${id}.tmp`)
    const output = createWriteStream(filePath, { flags: 'wx' })

    let reservedBytes = 0
    const meter = new Transform({
      transform: (chunk, _encoding, callback) => {
        try {
          const chunkBytes = getChunkByteLength(chunk)
          this.reserveBytes(chunkBytes)
          reservedBytes += chunkBytes
          callback(null, chunk)
        } catch (error) {
          callback(error as Error)
        }
      }
    })

    try {
      await pipeline(stream, meter, output)
    } catch (error) {
      this.totalBytes = Math.max(0, this.totalBytes - reservedBytes)
      await fs.rm(filePath, { force: true })
      throw error
    }

    this.entries.set(id, {
      filePath,
      byteLength: reservedBytes
    })

    return {
      filePath,
      byteLength: reservedBytes,
      cleanup: async () => {
        await this.release(id)
      }
    }
  }

  private reserveBytes(bytes: number): void {
    if (bytes <= 0) {
      return
    }

    if (typeof this.maxTotalBytes === 'number' && this.totalBytes + bytes > this.maxTotalBytes) {
      throw buildStorageLimitError(this.maxTotalBytes)
    }

    this.totalBytes += bytes
  }

  private async release(id: string): Promise<void> {
    const entry = this.entries.get(id)
    if (!entry) {
      return
    }

    this.entries.delete(id)
    this.totalBytes = Math.max(0, this.totalBytes - entry.byteLength)
    await fs.rm(entry.filePath, { force: true })
  }

  private async removeManagedArtifacts(): Promise<void> {
    let entries
    try {
      entries = await fs.readdir(this.storageDir, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return
      }
      throw error
    }

    await Promise.all(
      entries.map(async (entry) => {
        if (!entry.isFile()) {
          return
        }

        if (!MANAGED_UPLOAD_FILE_PATTERN.test(entry.name)) {
          return
        }

        await fs.rm(path.join(this.storageDir, entry.name), { force: true })
      })
    )
  }
}
