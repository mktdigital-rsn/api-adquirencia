import { describe, expect, it } from 'vitest'

import app from '../src/index'
import { isApprovedEstablishment, normalizeEstablishment } from '../src/normalize'

const env = { API_KEY_HASHES: '2bb80d537b1da3e38bd30361aa855686bde0eacd7162fef6a25fe97bf527a25b' }

describe('api-adquirencia worker', () => {
  it('returns its health check without authentication', async () => {
    const response = await app.request('http://localhost/health', undefined, env)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ ok: true, service: 'api-adquirencia' })
  })

  it('rejects business requests without an API key', async () => {
    const response = await app.request('http://localhost/api/establishments', undefined, env)
    expect(response.status).toBe(401)
  })

  it('rejects invalid API keys before calling the upstream service', async () => {
    const response = await app.request('http://localhost/api/establishments', { headers: { 'x-api-key': 'invalid' } }, env)
    expect(response.status).toBe(403)
  })

  it('recognizes and normalizes an approved establishment', () => {
    const normalized = normalizeEstablishment({ id: 10, nome_fantasia: 'Mercado Central', contactsJson: '{"email":"contato@exemplo.com"}', status: 'aprovado' })
    expect(normalized).toMatchObject({ id: 10, nomeFantasia: 'Mercado Central', contacts: { email: 'contato@exemplo.com' }, approved: true })
    expect(isApprovedEstablishment(normalized)).toBe(true)
  })
})
