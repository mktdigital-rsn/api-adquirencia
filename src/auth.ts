import type { MiddlewareHandler } from 'hono'

import type { AppEnv } from './env'
import { ApiError } from './errors'

const SHA_256_HASH = /^[a-f0-9]{64}$/

function parseAllowedApiKeyHashes(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => SHA_256_HASH.test(entry))
}

function readApiKey(authorization: string | undefined, apiKey: string | undefined): string | null {
  if (apiKey?.trim()) return apiKey.trim()
  if (authorization?.startsWith('Bearer ')) return authorization.slice('Bearer '.length).trim() || null
  return null
}

function hexToBytes(value: string): Uint8Array {
  return Uint8Array.from({ length: value.length / 2 }, (_, index) => Number.parseInt(value.slice(index * 2, index * 2 + 2), 16))
}

function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false

  let difference = 0
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index]
  return difference === 0
}

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
}

export const requireApiKey: MiddlewareHandler<{ Bindings: AppEnv }> = async (c, next) => {
  const apiKey = readApiKey(c.req.header('authorization'), c.req.header('x-api-key'))
  if (!apiKey) throw new ApiError(401, 'Chave de acesso ausente.')

  const allowedHashes = parseAllowedApiKeyHashes(c.env.API_KEY_HASHES)
  if (!allowedHashes.length) throw new ApiError(500, 'Chaves de acesso nao configuradas no servidor.')

  const providedHash = await sha256(apiKey)
  const isAllowed = allowedHashes.some((hash) => timingSafeEqual(providedHash, hexToBytes(hash)))
  if (!isAllowed) throw new ApiError(403, 'Chave de acesso invalida.')

  await next()
}

export { parseAllowedApiKeyHashes, timingSafeEqual }
