import assert from 'node:assert/strict'
import { test } from 'node:test'
import multipart from '@fastify/multipart'
import Fastify from 'fastify'
import sharp from 'sharp'
import { compressImages } from '../src/lib/compress.ts'
import compressRoutes from '../src/routes/compress.ts'

const AUTHORIZATION_HEADER = 'Bearer test-token'
const SERVICE_JPEG_QUALITY = 75

type Candidate = {
  buffer: Buffer
  width: number
  height: number
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

const buildMultipartPayload = (fileName: string, buffer: Buffer): { boundary: string; payload: Buffer } => {
  const boundary = '----codex-image-compress-test-boundary'
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${fileName}"\r\nContent-Type: image/jpeg\r\n\r\n`
  )
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`)

  return {
    boundary,
    payload: Buffer.concat([head, buffer, tail])
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

test('compress route derives outcome from actual fallback state instead of byte comparison', async (t) => {
  const app = Fastify()
  await app.register(multipart)
  await app.register(compressRoutes, { apiTokens: ['test-token'] })
  await app.ready()
  t.after(async () => {
    await app.close()
  })

  const rotatedCandidate = await findLargerOrEqualOutputCandidate(true)
  const rotatedRequest = buildMultipartPayload('rotated.jpg', rotatedCandidate.buffer)
  const rotatedMetadataResponse = await app.inject({
    method: 'POST',
    url: '/v1/compress?responseMode=metadata',
    headers: {
      authorization: AUTHORIZATION_HEADER,
      'content-type': `multipart/form-data; boundary=${rotatedRequest.boundary}`
    },
    payload: rotatedRequest.payload
  })

  assert.equal(rotatedMetadataResponse.statusCode, 200)
  const rotatedBody = rotatedMetadataResponse.json()
  assert.equal(rotatedBody.compressed, true)
  assert.equal(rotatedBody.outcome, 'compressed')
  assert.equal(rotatedBody.reason, undefined)
  assert.equal(rotatedBody.outputFileName, 'rotated_compressed.jpg')
  assert.ok(rotatedBody.outputBytes >= rotatedBody.originalBytes)
  assert.equal(rotatedBody.results[0]?.compressed, true)
  assert.equal(rotatedBody.results[0]?.outcome, 'compressed')
  assert.equal(rotatedBody.results[0]?.reason, undefined)

  const rotatedBinaryResponse = await app.inject({
    method: 'POST',
    url: '/v1/compress?responseMode=binary',
    headers: {
      authorization: AUTHORIZATION_HEADER,
      'content-type': `multipart/form-data; boundary=${rotatedRequest.boundary}`
    },
    payload: rotatedRequest.payload
  })

  assert.equal(rotatedBinaryResponse.statusCode, 200)
  assert.equal(rotatedBinaryResponse.headers['x-compressed'], 'true')
  assert.equal(rotatedBinaryResponse.headers['x-outcome'], 'compressed')
  assert.match(rotatedBinaryResponse.headers['content-disposition'] ?? '', /rotated_compressed\.jpg/)

  const plainCandidate = await findLargerOrEqualOutputCandidate(false)
  const plainRequest = buildMultipartPayload('plain.jpg', plainCandidate.buffer)
  const plainMetadataResponse = await app.inject({
    method: 'POST',
    url: '/v1/compress?responseMode=metadata',
    headers: {
      authorization: AUTHORIZATION_HEADER,
      'content-type': `multipart/form-data; boundary=${plainRequest.boundary}`
    },
    payload: plainRequest.payload
  })

  assert.equal(plainMetadataResponse.statusCode, 200)
  const plainBody = plainMetadataResponse.json()
  assert.equal(plainBody.compressed, false)
  assert.equal(plainBody.outcome, 'fallback_original')
  assert.equal(plainBody.reason, 'reencoded_not_smaller')
  assert.equal(plainBody.outputFileName, 'plain.jpg')
  assert.equal(plainBody.outputBytes, plainBody.originalBytes)
  assert.equal(plainBody.results[0]?.compressed, false)
  assert.equal(plainBody.results[0]?.outcome, 'fallback_original')
  assert.equal(plainBody.results[0]?.reason, 'reencoded_not_smaller')

  const plainBinaryResponse = await app.inject({
    method: 'POST',
    url: '/v1/compress?responseMode=binary',
    headers: {
      authorization: AUTHORIZATION_HEADER,
      'content-type': `multipart/form-data; boundary=${plainRequest.boundary}`
    },
    payload: plainRequest.payload
  })

  assert.equal(plainBinaryResponse.statusCode, 200)
  assert.equal(plainBinaryResponse.headers['x-compressed'], 'false')
  assert.equal(plainBinaryResponse.headers['x-outcome'], 'fallback_original')
  assert.match(plainBinaryResponse.headers['content-disposition'] ?? '', /plain\.jpg/)
})
