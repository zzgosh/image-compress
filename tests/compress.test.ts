import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm as removeFileSystemEntry, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import multipart from '@fastify/multipart'
import Fastify from 'fastify'
import sharp from 'sharp'
import { compressImages } from '../src/lib/compress.ts'
import { EphemeralResultStore } from '../src/lib/result-store.ts'
import { formatMegabyteSize } from '../src/lib/size.ts'
import {
  DEFAULT_UPLOAD_MAX_FILE_COUNT,
  DEFAULT_UPLOAD_MAX_FILE_SIZE_BYTES,
  DEFAULT_UPLOAD_MAX_TOTAL_SIZE_BYTES
} from '../src/lib/validate.ts'
import compressRoutes from '../src/routes/compress.ts'
import resultRoutes from '../src/routes/results.ts'
import { HttpError } from '../src/types/api.ts'

const AUTHORIZATION_HEADER = 'Bearer test-token'
const API_BASE_PATH = '/api/image-compress'
const SERVICE_JPEG_QUALITY = 75
const TEST_IMAGES_DIR = path.resolve(process.cwd(), 'test_images')

type SupportedFixtureFormat = 'jpeg' | 'png' | 'webp'

type Candidate = {
  buffer: Buffer
  width: number
  height: number
}

type FixtureFile = {
  fileName: string
  buffer: Buffer
  contentType: string
  detectedFormat?: SupportedFixtureFormat
}

type SupportedFixtureFile = FixtureFile & {
  detectedFormat: SupportedFixtureFormat
}

type MultipartField =
  | {
      kind: 'file'
      fieldname: string
      fileName: string
      contentType: string
      buffer: Buffer
    }
  | {
      kind: 'field'
      fieldname: string
      value: string
    }

const createPixels = (width: number, height: number, seed: number): Buffer => {
  const buffer = Buffer.alloc(width * height * 3)

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 3
      buffer[index] = (x * 31 + y * 17 + seed * 13) % 256
      buffer[index + 1] = (x * 11 + y * 29 + seed * 19) % 256
      buffer[index + 2] = (x * 23 + y * 7 + seed * 5) % 256
    }
  }

  return buffer
}

const createJpegCandidate = async (width: number, height: number, quality: number, seed: number, orientation?: number): Promise<Buffer> => {
  let pipeline = sharp(createPixels(width, height, seed), {
    raw: {
      width,
      height,
      channels: 3
    }
  }).jpeg({ quality })

  if (typeof orientation === 'number') {
    pipeline = pipeline.withMetadata({ orientation })
  }

  return pipeline.toBuffer()
}

const reencodeLikeService = async (inputBuffer: Buffer): Promise<Buffer> =>
  sharp(inputBuffer).rotate().jpeg({ quality: SERVICE_JPEG_QUALITY, mozjpeg: true }).toBuffer()

const findLargerOrEqualOutputCandidate = async (needsRotate: boolean): Promise<Candidate> => {
  const sizes: Array<[number, number]> = [
    [17, 23],
    [23, 29],
    [31, 41],
    [41, 53]
  ]
  const qualities = [1, 5, 10, 20, 30, 40, 50]
  const orientation = needsRotate ? 6 : undefined

  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    for (const quality of qualities) {
      for (const [width, height] of sizes) {
        const buffer = await createJpegCandidate(width, height, quality, seed, orientation)
        const reencoded = await reencodeLikeService(buffer)
        if (reencoded.length >= buffer.length) {
          return { buffer, width, height }
        }
      }
    }
  }

  throw new Error(`failed to build a ${needsRotate ? 'rotated' : 'non-rotated'} JPEG candidate with non-smaller re-encode output`)
}

const FIXTURE_CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  '.ai': 'application/postscript',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp'
}

const OUTPUT_MIME_BY_FORMAT: Record<SupportedFixtureFormat, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp'
}

const encodeRfc5987Value = (value: string): string =>
  encodeURIComponent(value).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)

const splitFileName = (fileName: string): { baseName: string; extension: string } => {
  const dotIndex = fileName.lastIndexOf('.')
  if (dotIndex <= 0 || dotIndex === fileName.length - 1) {
    return { baseName: fileName, extension: '' }
  }

  return {
    baseName: fileName.slice(0, dotIndex),
    extension: fileName.slice(dotIndex + 1)
  }
}

const buildExpectedCompressedFileName = (sourceFileName: string, format: SupportedFixtureFormat): string => {
  const { baseName, extension } = splitFileName(sourceFileName)
  if (format === 'jpeg') {
    return extension.toLowerCase() === 'jpeg' ? `${baseName}_compressed.jpeg` : `${baseName}_compressed.jpg`
  }

  return `${baseName}_compressed.${format}`
}

const buildMultipartPayload = (fields: MultipartField[]): { boundary: string; payload: Buffer } => {
  const boundary = '----codex-image-compress-test-boundary'
  const chunks: Buffer[] = []

  for (const field of fields) {
    if (field.kind === 'file') {
      chunks.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${field.fieldname}"; filename="${field.fileName}"\r\nContent-Type: ${field.contentType}\r\n\r\n`
        )
      )
      chunks.push(field.buffer)
      chunks.push(Buffer.from('\r\n'))
      continue
    }

    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${field.fieldname}"\r\n\r\n${field.value}\r\n`))
  }

  chunks.push(Buffer.from(`--${boundary}--\r\n`))

  return {
    boundary,
    payload: Buffer.concat(chunks)
  }
}

let fixtureFilesPromise: Promise<FixtureFile[]> | undefined

const loadFixtureFiles = async (): Promise<FixtureFile[]> => {
  fixtureFilesPromise ??= (async () => {
    let names: string[]
    try {
      names = (await readdir(TEST_IMAGES_DIR)).sort()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return []
      }
      throw error
    }

    return Promise.all(
      names.map(async (fileName) => {
        const extension = path.extname(fileName).toLowerCase()
        const buffer = await readFile(path.join(TEST_IMAGES_DIR, fileName))

        let detectedFormat: SupportedFixtureFormat | undefined
        try {
          const metadata = await sharp(buffer).metadata()
          if (metadata.format === 'jpeg' || metadata.format === 'png' || metadata.format === 'webp') {
            detectedFormat = metadata.format
          }
        } catch {
          // ignore unsupported fixtures here; dedicated tests will assert route behavior.
        }

        return {
          fileName,
          buffer,
          contentType: FIXTURE_CONTENT_TYPE_BY_EXTENSION[extension] ?? 'application/octet-stream',
          detectedFormat
        }
      })
    )
  })()

  return fixtureFilesPromise
}

const loadSupportedFixtureFiles = async (): Promise<SupportedFixtureFile[]> =>
  (await loadFixtureFiles()).filter((fixture): fixture is SupportedFixtureFile => Boolean(fixture.detectedFormat))

const loadUnsupportedFixtureFiles = async (): Promise<FixtureFile[]> =>
  (await loadFixtureFiles()).filter((fixture) => !fixture.detectedFormat)

const createApp = async (options?: {
  now?: () => number
  ttlMs?: number
  maxTotalBytes?: number
  uploadLimits?: {
    maxFileCount?: number
    maxFileSizeBytes?: number
    maxTotalSizeBytes?: number
  }
}) => {
  const app = Fastify()
  const resultStore = new EphemeralResultStore({
    now: options?.now,
    ttlMs: options?.ttlMs ?? 300_000,
    maxTotalBytes: options?.maxTotalBytes ?? 256 * 1024 * 1024
  })
  const uploadLimits = {
    maxFileCount: options?.uploadLimits?.maxFileCount ?? DEFAULT_UPLOAD_MAX_FILE_COUNT,
    maxFileSizeBytes: options?.uploadLimits?.maxFileSizeBytes ?? DEFAULT_UPLOAD_MAX_FILE_SIZE_BYTES,
    maxTotalSizeBytes: options?.uploadLimits?.maxTotalSizeBytes ?? DEFAULT_UPLOAD_MAX_TOTAL_SIZE_BYTES
  }

  await resultStore.init()
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
        message = `request body exceeds ${formatMegabyteSize(uploadLimits.maxTotalSizeBytes + 10 * 1024 * 1024)}`
      } else if (knownError.code === 'FST_REQ_FILE_TOO_LARGE') {
        message = `single file size exceeds ${formatMegabyteSize(uploadLimits.maxFileSizeBytes)}`
      } else if (knownError.code === 'FST_FILES_LIMIT') {
        message = `file count exceeds ${uploadLimits.maxFileCount}`
      }

      reply.status(413).send({
        error: {
          code: 'PAYLOAD_TOO_LARGE',
          message
        }
      })
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

  await app.register(multipart)
  await app.register(compressRoutes, {
    apiTokens: ['test-token'],
    apiBasePath: API_BASE_PATH,
    publicBaseUrl: 'http://127.0.0.1:3001',
    resultStore,
    uploadLimits,
    prefix: API_BASE_PATH
  })
  await app.register(resultRoutes, {
    resultStore,
    prefix: API_BASE_PATH
  })
  await app.ready()

  return app
}

const createTempStorageDir = async (): Promise<string> => mkdtemp(path.join(tmpdir(), 'image-compress-result-store-test-'))

const getRawPayload = (response: { rawPayload: Buffer }): Buffer => response.rawPayload

const assertDownloadConsumedOnce = async (
  app: Awaited<ReturnType<typeof createApp>>,
  downloadUrl: string
): Promise<{ payload: Buffer; response: Awaited<ReturnType<typeof app.inject>> }> => {
  const url = new URL(downloadUrl)
  const firstDownload = await app.inject({
    method: 'GET',
    url: `${url.pathname}${url.search}`
  })

  assert.equal(firstDownload.statusCode, 200)
  const payload = getRawPayload(firstDownload as { rawPayload: Buffer })

  const secondDownload = await app.inject({
    method: 'GET',
    url: `${url.pathname}${url.search}`
  })

  assert.equal(secondDownload.statusCode, 404)
  assert.equal(secondDownload.json().error.code, 'NOT_FOUND')

  return {
    payload,
    response: firstDownload
  }
}

test('compressImages keeps rotated JPEG output when EXIF normalization makes it larger', async () => {
  const candidate = await findLargerOrEqualOutputCandidate(true)
  const [result] = await compressImages([
    {
      buffer: candidate.buffer,
      fileName: 'rotated.jpg',
      byteLength: candidate.buffer.length
    }
  ])

  assert.ok(result)
  assert.equal(result.usedFallback, false)
  assert.equal(result.fileName, 'rotated_compressed.jpg')
  assert.ok(result.compressedBytes >= candidate.buffer.length)
  assert.equal(result.buffer.equals(candidate.buffer), false)

  const originalMetadata = await sharp(candidate.buffer).metadata()
  const outputMetadata = await sharp(result.buffer).metadata()

  assert.equal(originalMetadata.orientation, 6)
  assert.equal(outputMetadata.width, candidate.height)
  assert.equal(outputMetadata.height, candidate.width)
  assert.notEqual(outputMetadata.orientation, 6)
})

test('result store only removes service-managed artifacts inside the storage directory', async (t) => {
  const storageDir = await createTempStorageDir()
  t.after(async () => {
    await removeFileSystemEntry(storageDir, { recursive: true, force: true })
  })

  await writeFile(path.join(storageDir, 'keep.txt'), 'preserve-me')
  await writeFile(path.join(storageDir, 'result-00000000-0000-0000-0000-000000000000.bin'), 'stale-managed')

  const store = new EphemeralResultStore({
    storageDir,
    ttlMs: 300_000,
    maxTotalBytes: 1024 * 1024
  })
  t.after(async () => {
    await store.close()
  })

  await store.init()

  const namesAfterInit = (await readdir(storageDir)).sort()
  assert.deepEqual(namesAfterInit, ['.image-compress-result-store', 'keep.txt'])

  await store.create({
    type: 'single',
    fileName: 'demo.jpg',
    mimeType: 'image/jpeg',
    buffer: Buffer.from('managed-result')
  })

  const namesAfterCreate = (await readdir(storageDir)).sort()
  assert.equal(namesAfterCreate.includes('keep.txt'), true)
  assert.equal(namesAfterCreate.includes('.image-compress-result-store'), true)
  assert.equal(namesAfterCreate.some((name) => name.startsWith('result-') && name.endsWith('.bin')), true)

  await store.close()

  const namesAfterClose = (await readdir(storageDir)).sort()
  assert.deepEqual(namesAfterClose, ['.image-compress-result-store', 'keep.txt'])
})

test('result store serializes concurrent creates so the storage cap cannot be overshot', async (t) => {
  const storageDir = await createTempStorageDir()
  t.after(async () => {
    await removeFileSystemEntry(storageDir, { recursive: true, force: true })
  })

  const buffer = Buffer.alloc(1024, 7)
  const store = new EphemeralResultStore({
    storageDir,
    ttlMs: 300_000,
    maxTotalBytes: buffer.length + 128
  })
  t.after(async () => {
    await store.close()
  })

  await store.init()

  const results = await Promise.allSettled([
    store.create({
      type: 'single',
      fileName: 'first.jpg',
      mimeType: 'image/jpeg',
      buffer
    }),
    store.create({
      type: 'single',
      fileName: 'second.jpg',
      mimeType: 'image/jpeg',
      buffer
    })
  ])

  const fulfilledCount = results.filter((result) => result.status === 'fulfilled').length
  const rejectedResults = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')

  assert.equal(fulfilledCount, 1)
  assert.equal(rejectedResults.length, 1)
  assert.ok(rejectedResults[0].reason instanceof HttpError)
  assert.equal(rejectedResults[0].reason.statusCode, 507)
  assert.equal(rejectedResults[0].reason.code, 'INSUFFICIENT_STORAGE')
})

test('compress route returns metadata and a one-time download URL for single file output', async (t) => {
  const app = await createApp()
  t.after(async () => {
    await app.close()
  })

  const rotatedCandidate = await findLargerOrEqualOutputCandidate(true)
  const requestBody = buildMultipartPayload([
    {
      kind: 'file',
      fieldname: 'files',
      fileName: 'rotated.jpg',
      contentType: 'image/jpeg',
      buffer: rotatedCandidate.buffer
    }
  ])

  const metadataResponse = await app.inject({
    method: 'POST',
    url: `${API_BASE_PATH}/v1/compress`,
    headers: {
      authorization: AUTHORIZATION_HEADER,
      'content-type': `multipart/form-data; boundary=${requestBody.boundary}`
    },
    payload: requestBody.payload
  })

  assert.equal(metadataResponse.statusCode, 200)
  const body = metadataResponse.json()
  assert.equal(body.success, true)
  assert.equal(body.compressed, true)
  assert.equal(body.outcome, 'compressed')
  assert.equal(body.outputType, 'single')
  assert.equal(body.outputMimeType, 'image/jpeg')
  assert.equal(body.outputFileName, 'rotated_compressed.jpg')
  assert.equal(body.download.singleUse, true)
  assert.match(body.download.url, /\/api\/image-compress\/v1\/results\//)

  const downloadUrl = new URL(body.download.url)
  const downloadResponse = await app.inject({
    method: 'GET',
    url: `${downloadUrl.pathname}${downloadUrl.search}`
  })

  assert.equal(downloadResponse.statusCode, 200)
  assert.equal(downloadResponse.headers['content-type'], 'image/jpeg')
  assert.match(downloadResponse.headers['content-disposition'] ?? '', /rotated_compressed\.jpg/)
  assert.ok(getRawPayload(downloadResponse as { rawPayload: Buffer }).length > 0)

  const secondDownloadResponse = await app.inject({
    method: 'GET',
    url: `${downloadUrl.pathname}${downloadUrl.search}`
  })

  assert.equal(secondDownloadResponse.statusCode, 404)
  assert.equal(secondDownloadResponse.json().error.code, 'NOT_FOUND')
})

test('compress route exposes fallback metadata and downloadable original bytes when output is not smaller', async (t) => {
  const app = await createApp()
  t.after(async () => {
    await app.close()
  })

  const plainCandidate = await findLargerOrEqualOutputCandidate(false)
  const requestBody = buildMultipartPayload([
    {
      kind: 'file',
      fieldname: 'files',
      fileName: 'plain.jpg',
      contentType: 'image/jpeg',
      buffer: plainCandidate.buffer
    }
  ])

  const metadataResponse = await app.inject({
    method: 'POST',
    url: `${API_BASE_PATH}/v1/compress`,
    headers: {
      authorization: AUTHORIZATION_HEADER,
      'content-type': `multipart/form-data; boundary=${requestBody.boundary}`
    },
    payload: requestBody.payload
  })

  assert.equal(metadataResponse.statusCode, 200)
  const body = metadataResponse.json()
  assert.equal(body.compressed, false)
  assert.equal(body.outcome, 'fallback_original')
  assert.equal(body.reason, 'reencoded_not_smaller')
  assert.equal(body.outputFileName, 'plain.jpg')
  assert.equal(body.outputBytes, body.originalBytes)
  assert.equal(body.results[0]?.compressed, false)

  const downloadUrl = new URL(body.download.url)
  const downloadResponse = await app.inject({
    method: 'GET',
    url: `${downloadUrl.pathname}${downloadUrl.search}`
  })

  assert.equal(downloadResponse.statusCode, 200)
  assert.equal(getRawPayload(downloadResponse as { rawPayload: Buffer }).equals(plainCandidate.buffer), true)
})

test('compress route stores multi-file output as a ZIP and returns downloadable metadata', async (t) => {
  const app = await createApp()
  t.after(async () => {
    await app.close()
  })

  const firstCandidate = await createJpegCandidate(32, 32, 60, 1)
  const secondCandidate = await createJpegCandidate(24, 24, 55, 2)
  const requestBody = buildMultipartPayload([
    {
      kind: 'file',
      fieldname: 'files',
      fileName: 'a.jpg',
      contentType: 'image/jpeg',
      buffer: firstCandidate
    },
    {
      kind: 'file',
      fieldname: 'files',
      fileName: 'b.jpg',
      contentType: 'image/jpeg',
      buffer: secondCandidate
    },
    {
      kind: 'field',
      fieldname: 'zipName',
      value: 'my_batch'
    }
  ])

  const metadataResponse = await app.inject({
    method: 'POST',
    url: `${API_BASE_PATH}/v1/compress`,
    headers: {
      authorization: AUTHORIZATION_HEADER,
      'content-type': `multipart/form-data; boundary=${requestBody.boundary}`
    },
    payload: requestBody.payload
  })

  assert.equal(metadataResponse.statusCode, 200)
  const body = metadataResponse.json()
  assert.equal(body.outputType, 'zip')
  assert.equal(body.outputMimeType, 'application/zip')
  assert.equal(body.outputFileName, 'my_batch.zip')
  assert.equal(body.fileCount, 2)
  assert.equal(body.results.length, 2)

  const downloadUrl = new URL(body.download.url)
  const downloadResponse = await app.inject({
    method: 'GET',
    url: `${downloadUrl.pathname}${downloadUrl.search}`
  })

  assert.equal(downloadResponse.statusCode, 200)
  assert.equal(downloadResponse.headers['content-type'], 'application/zip')
  assert.match(downloadResponse.headers['content-disposition'] ?? '', /my_batch\.zip/)
  assert.ok(getRawPayload(downloadResponse as { rawPayload: Buffer }).length > 0)
})

test('expired results are cleaned before download', async (t) => {
  let now = Date.now()
  const app = await createApp({
    now: () => now,
    ttlMs: 1_000
  })
  t.after(async () => {
    await app.close()
  })

  const candidate = await createJpegCandidate(32, 32, 60, 3)
  const requestBody = buildMultipartPayload([
    {
      kind: 'file',
      fieldname: 'files',
      fileName: 'expired.jpg',
      contentType: 'image/jpeg',
      buffer: candidate
    }
  ])

  const metadataResponse = await app.inject({
    method: 'POST',
    url: `${API_BASE_PATH}/v1/compress`,
    headers: {
      authorization: AUTHORIZATION_HEADER,
      'content-type': `multipart/form-data; boundary=${requestBody.boundary}`
    },
    payload: requestBody.payload
  })

  const body = metadataResponse.json()
  const downloadUrl = new URL(body.download.url)
  now += 1_001

  const expiredResponse = await app.inject({
    method: 'GET',
    url: `${downloadUrl.pathname}${downloadUrl.search}`
  })

  assert.equal(expiredResponse.statusCode, 404)
  assert.equal(expiredResponse.json().error.code, 'NOT_FOUND')
})

test('compress route rejects legacy responseMode usage', async (t) => {
  const app = await createApp()
  t.after(async () => {
    await app.close()
  })

  const candidate = await createJpegCandidate(32, 32, 60, 4)
  const requestBody = buildMultipartPayload([
    {
      kind: 'file',
      fieldname: 'files',
      fileName: 'legacy.jpg',
      contentType: 'image/jpeg',
      buffer: candidate
    }
  ])

  const response = await app.inject({
    method: 'POST',
    url: `${API_BASE_PATH}/v1/compress?responseMode=binary`,
    headers: {
      authorization: AUTHORIZATION_HEADER,
      'content-type': `multipart/form-data; boundary=${requestBody.boundary}`
    },
    payload: requestBody.payload
  })

  assert.equal(response.statusCode, 400)
  assert.equal(response.json().error.code, 'INVALID_ARGUMENT')
})

test('compress route returns a human-friendly MB message when total upload size is too large', async (t) => {
  const app = await createApp({
    uploadLimits: {
      maxTotalSizeBytes: 16
    }
  })
  t.after(async () => {
    await app.close()
  })

  const candidate = await createJpegCandidate(32, 32, 60, 5)
  const requestBody = buildMultipartPayload([
    {
      kind: 'file',
      fieldname: 'files',
      fileName: 'too-large.jpg',
      contentType: 'image/jpeg',
      buffer: candidate
    }
  ])

  const response = await app.inject({
    method: 'POST',
    url: `${API_BASE_PATH}/v1/compress`,
    headers: {
      authorization: AUTHORIZATION_HEADER,
      'content-type': `multipart/form-data; boundary=${requestBody.boundary}`
    },
    payload: requestBody.payload
  })

  assert.equal(response.statusCode, 413)
  assert.equal(response.json().error.code, 'PAYLOAD_TOO_LARGE')
  assert.equal(response.json().error.message, `total upload size exceeds ${formatMegabyteSize(16)}`)
})

test('compress route fails explicitly when temporary result storage is full', async (t) => {
  const app = await createApp({
    maxTotalBytes: 16
  })
  t.after(async () => {
    await app.close()
  })

  const candidate = await createJpegCandidate(32, 32, 60, 5)
  const requestBody = buildMultipartPayload([
    {
      kind: 'file',
      fieldname: 'files',
      fileName: 'storage.jpg',
      contentType: 'image/jpeg',
      buffer: candidate
    }
  ])

  const response = await app.inject({
    method: 'POST',
    url: `${API_BASE_PATH}/v1/compress`,
    headers: {
      authorization: AUTHORIZATION_HEADER,
      'content-type': `multipart/form-data; boundary=${requestBody.boundary}`
    },
    payload: requestBody.payload
  })

  assert.equal(response.statusCode, 507)
  assert.equal(response.json().error.code, 'INSUFFICIENT_STORAGE')
  assert.equal(response.json().error.message, `temporary result storage limit reached (${formatMegabyteSize(16)})`)
})

test('compress route handles all supported real fixture files as single-file uploads and preserves original file names', async (t) => {
  const fixtures = await loadSupportedFixtureFiles()
  if (fixtures.length === 0) {
    t.skip('test_images/ is not present; skipping local real-fixture coverage')
    return
  }

  const app = await createApp()
  t.after(async () => {
    await app.close()
  })

  for (const fixture of fixtures) {
    const requestBody = buildMultipartPayload([
      {
        kind: 'file',
        fieldname: 'files',
        fileName: fixture.fileName,
        contentType: fixture.contentType,
        buffer: fixture.buffer
      }
    ])

    const metadataResponse = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/v1/compress`,
      headers: {
        authorization: AUTHORIZATION_HEADER,
        'content-type': `multipart/form-data; boundary=${requestBody.boundary}`
      },
      payload: requestBody.payload
    })

    assert.equal(metadataResponse.statusCode, 200, fixture.fileName)
    const body = metadataResponse.json()

    assert.equal(body.success, true, fixture.fileName)
    assert.equal(body.outputType, 'single', fixture.fileName)
    assert.equal(body.outputMimeType, OUTPUT_MIME_BY_FORMAT[fixture.detectedFormat], fixture.fileName)
    assert.equal(body.fileCount, 1, fixture.fileName)
    assert.equal(body.results.length, 1, fixture.fileName)
    assert.equal(body.results[0]?.originalFileName, fixture.fileName, fixture.fileName)
    assert.equal(body.results[0]?.originalBytes, fixture.buffer.length, fixture.fileName)
    assert.equal(body.results[0]?.outputBytes, body.outputBytes, fixture.fileName)
    assert.equal(body.results[0]?.outputFileName, body.outputFileName, fixture.fileName)
    assert.equal(body.results[0]?.outputMimeType, body.outputMimeType, fixture.fileName)
    assert.equal(body.results[0]?.compressed, body.compressed, fixture.fileName)
    assert.equal(body.results[0]?.outcome, body.outcome, fixture.fileName)
    assert.equal(typeof body.download.url, 'string', fixture.fileName)
    assert.equal(body.download.singleUse, true, fixture.fileName)

    if (body.compressed) {
      assert.equal(body.outcome, 'compressed', fixture.fileName)
      assert.ok(body.outputBytes < body.originalBytes, fixture.fileName)
      assert.equal(body.reason, undefined, fixture.fileName)
      assert.equal(body.outputFileName, buildExpectedCompressedFileName(fixture.fileName, fixture.detectedFormat), fixture.fileName)
    } else {
      assert.equal(body.outcome, 'fallback_original', fixture.fileName)
      assert.equal(body.reason, 'reencoded_not_smaller', fixture.fileName)
      assert.equal(body.outputBytes, body.originalBytes, fixture.fileName)
      assert.equal(body.outputFileName, fixture.fileName, fixture.fileName)
    }

    const { payload: downloadedBuffer, response: downloadResponse } = await assertDownloadConsumedOnce(app, body.download.url)
    assert.equal(downloadedBuffer.length, body.outputBytes, fixture.fileName)
    assert.equal(downloadResponse.headers['content-type'], body.outputMimeType, fixture.fileName)
    assert.ok(
      (downloadResponse.headers['content-disposition'] ?? '').includes(`filename*=UTF-8''${encodeRfc5987Value(body.outputFileName)}`),
      fixture.fileName
    )

    const downloadedMetadata = await sharp(downloadedBuffer).metadata()
    const originalMetadata = await sharp(fixture.buffer).metadata()
    assert.equal(downloadedMetadata.format, fixture.detectedFormat, fixture.fileName)
    assert.equal(downloadedMetadata.width, originalMetadata.width, fixture.fileName)
    assert.equal(downloadedMetadata.height, originalMetadata.height, fixture.fileName)

    if (!body.compressed) {
      assert.equal(downloadedBuffer.equals(fixture.buffer), true, fixture.fileName)
    }
  }
})

test('compress route handles all supported real fixture files as a batch zip download and preserves zip name', async (t) => {
  const fixtures = await loadSupportedFixtureFiles()
  if (fixtures.length === 0) {
    t.skip('test_images/ is not present; skipping local real-fixture coverage')
    return
  }

  if (fixtures.length < 2) {
    t.skip('test_images/ does not contain enough supported fixtures for batch coverage')
    return
  }

  const app = await createApp()
  t.after(async () => {
    await app.close()
  })

  const requestBody = buildMultipartPayload([
    ...fixtures.map((fixture) => ({
      kind: 'file' as const,
      fieldname: 'files',
      fileName: fixture.fileName,
      contentType: fixture.contentType,
      buffer: fixture.buffer
    })),
    {
      kind: 'field' as const,
      fieldname: 'zipName',
      value: '中秋素材包'
    }
  ])

  const metadataResponse = await app.inject({
    method: 'POST',
    url: `${API_BASE_PATH}/v1/compress`,
    headers: {
      authorization: AUTHORIZATION_HEADER,
      'content-type': `multipart/form-data; boundary=${requestBody.boundary}`
    },
    payload: requestBody.payload
  })

  assert.equal(metadataResponse.statusCode, 200)
  const body = metadataResponse.json()

  assert.equal(body.success, true)
  assert.equal(body.outputType, 'zip')
  assert.equal(body.outputMimeType, 'application/zip')
  assert.equal(body.outputFileName, '中秋素材包.zip')
  assert.equal(body.fileCount, fixtures.length)
  assert.equal(body.results.length, fixtures.length)
  assert.deepEqual(
    body.results.map((result: { originalFileName: string }) => result.originalFileName),
    fixtures.map((fixture) => fixture.fileName)
  )
  assert.equal(
    body.originalBytes,
    fixtures.reduce((total, fixture) => total + fixture.buffer.length, 0)
  )
  assert.ok(body.outputBytes > 0)
  assert.equal(body.download.singleUse, true)

  const { payload: downloadedZip, response: downloadResponse } = await assertDownloadConsumedOnce(app, body.download.url)
  assert.ok(downloadedZip.length > 0)
  assert.equal(downloadResponse.headers['content-type'], 'application/zip')
  assert.ok((downloadResponse.headers['content-disposition'] ?? '').includes(`filename*=UTF-8''${encodeRfc5987Value(body.outputFileName)}`))
})

test('compress route rejects unsupported or undecodable real fixture files explicitly', async (t) => {
  const fixtures = await loadUnsupportedFixtureFiles()
  if (fixtures.length === 0) {
    t.skip('test_images/ is not present or does not contain unsupported fixtures')
    return
  }

  const app = await createApp()
  t.after(async () => {
    await app.close()
  })

  for (const fixture of fixtures) {
    const requestBody = buildMultipartPayload([
      {
        kind: 'file',
        fieldname: 'files',
        fileName: fixture.fileName,
        contentType: fixture.contentType,
        buffer: fixture.buffer
      }
    ])

    const response = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/v1/compress`,
      headers: {
        authorization: AUTHORIZATION_HEADER,
        'content-type': `multipart/form-data; boundary=${requestBody.boundary}`
      },
      payload: requestBody.payload
    })

    const errorPayload = response.json().error
    if (response.statusCode === 415) {
      assert.equal(errorPayload.code, 'UNSUPPORTED_MEDIA_TYPE', fixture.fileName)
      continue
    }

    assert.equal(response.statusCode, 422, fixture.fileName)
    assert.equal(errorPayload.code, 'PROCESSING_FAILED', fixture.fileName)
  }
})
