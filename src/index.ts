import { Hono } from 'hono'

import { fetchEstablishmentById, fetchEstablishments } from './agents-api'
import { requireApiKey } from './auth'
import type { AppEnv } from './env'
import { ApiError } from './errors'
import { isApprovedEstablishment, normalizeEstablishment } from './normalize'

const DEFAULT_AGENTS_API_BASE_URL = 'https://agentes-api.bancog8dev.workers.dev'
const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_MAX_PAGES = 20

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

const app = new Hono<{ Bindings: AppEnv }>()

app.onError((error, c) => {
  const apiError = error instanceof ApiError ? error : new ApiError(500, 'Erro interno ao processar a requisicao.')
  return new Response(JSON.stringify({ error: { message: apiError.message, statusCode: apiError.statusCode, requestId: crypto.randomUUID() } }), {
    status: apiError.statusCode,
    headers: { 'cache-control': 'no-store', 'content-type': 'application/json; charset=UTF-8' },
  })
})

app.notFound((c) => c.json({ error: { message: 'Rota nao encontrada.', statusCode: 404, requestId: crypto.randomUUID() } }, 404, { 'cache-control': 'no-store' }))

app.get('/health', (c) => c.json({ ok: true, service: 'api-adquirencia', timestamp: new Date().toISOString() }, 200, { 'cache-control': 'no-store' }))

app.use('/api/establishments/*', requireApiKey)
app.use('/api/establishments', requireApiKey)

app.get('/api/establishments', async (c) => {
  const items = await fetchEstablishments({ baseUrl: c.env.AGENTS_API_BASE_URL ?? DEFAULT_AGENTS_API_BASE_URL, timeoutMs: positiveInteger(c.env.AGENTS_API_TIMEOUT_MS, DEFAULT_TIMEOUT_MS), maxPages: positiveInteger(c.env.AGENTS_API_MAX_PAGES, DEFAULT_MAX_PAGES) })
  const establishments = items.map(normalizeEstablishment).filter(isApprovedEstablishment)
  return c.json({ data: establishments, meta: { total: establishments.length, source: 'agents-api', filtered: 'approved-only' } }, 200, { 'cache-control': 'no-store' })
})

app.get('/api/establishments/:id', async (c) => {
  const establishment = normalizeEstablishment(await fetchEstablishmentById({ baseUrl: c.env.AGENTS_API_BASE_URL ?? DEFAULT_AGENTS_API_BASE_URL, id: c.req.param('id'), timeoutMs: positiveInteger(c.env.AGENTS_API_TIMEOUT_MS, DEFAULT_TIMEOUT_MS) }))
  if (!isApprovedEstablishment(establishment)) throw new ApiError(404, 'Estabelecimento nao encontrado.')
  return c.json({ data: establishment, meta: { source: 'agents-api' } }, 200, { 'cache-control': 'no-store' })
})

export default app
