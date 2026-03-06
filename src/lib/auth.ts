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

const safeTokenMatchAny = (providedToken: string, expectedTokens: readonly string[]): boolean => {
  let matched = false

  // 不因“匹配顺序”提前返回，降低可观测的时序差异。
  for (const expectedToken of expectedTokens) {
    matched = safeTokenCompare(providedToken, expectedToken) || matched
  }

  return matched
}

export const assertAuthorized = (authorizationHeader: string | undefined, expectedTokens: readonly string[]): void => {
  if (!authorizationHeader) {
    throw new HttpError(401, 'UNAUTHORIZED', 'missing Authorization header')
  }

  const matched = authorizationHeader.match(BEARER_PREFIX)
  if (!matched || !matched[1]) {
    throw new HttpError(401, 'UNAUTHORIZED', 'invalid Authorization header format')
  }

  const providedToken = matched[1].trim()
  if (!providedToken || !safeTokenMatchAny(providedToken, expectedTokens)) {
    throw new HttpError(401, 'UNAUTHORIZED', 'invalid token')
  }
}
