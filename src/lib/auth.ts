import { timingSafeEqual } from 'node:crypto'
import { HttpError } from '../types/api.js'

const BEARER_PREFIX = /^Bearer\s+(.+)$/i

const safeTokenCompare = (provided: string, expected: string): boolean => {
  const providedBuffer = Buffer.from(provided)
  const expectedBuffer = Buffer.from(expected)

  if (providedBuffer.length !== expectedBuffer.length) {
    return false
  }

  return timingSafeEqual(providedBuffer, expectedBuffer)
}

export const assertAuthorized = (authorizationHeader: string | undefined, expectedToken: string): void => {
  if (!authorizationHeader) {
    throw new HttpError(401, 'UNAUTHORIZED', 'missing Authorization header')
  }

  const matched = authorizationHeader.match(BEARER_PREFIX)
  if (!matched || !matched[1]) {
    throw new HttpError(401, 'UNAUTHORIZED', 'invalid Authorization header format')
  }

  const providedToken = matched[1].trim()
  if (!providedToken || !safeTokenCompare(providedToken, expectedToken)) {
    throw new HttpError(401, 'UNAUTHORIZED', 'invalid token')
  }
}
