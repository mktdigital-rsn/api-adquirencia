import { renderCreditDashboard } from './credit-dashboard'
import { creditDashboardScript } from './credit-dashboard-client'
import { renderCreditDocs } from './credit-docs'
import { createCreditRoutes } from './credit-leads'
import { Hono } from 'hono'

import { fetchEstablishmentById, fetchEstablishments } from './agents-api'
import { requireApiKey } from './auth'
import type { AppEnv } from './env'
import { ApiError } from './errors'
import { isApprovedEstablishment, normalizeEstablishment } from './normalize'
import { buildOpenApiSpec, renderDocsHtml } from './openapi'
import { createWebhookManager } from './webhooks'

const DEFAULT_AGENTS_API_BASE_URL = 'https://agentes-api.bancog8dev.workers.dev'
const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_MAX_PAGES = 20
const DEFAULT_WEBHOOK_BASE_URL = 'https://api-adquirencia.bancog8.com.br'

type WebhookManager = ReturnType<typeof createWebhookManager>

const webhookManagerCache = new Map<string, WebhookManager>()

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function resolveWebhookManager(env: AppEnv) {
  const cacheKey = [
    env.TURSO_DATABASE_URL ?? '',
    env.TURSO_AUTH_TOKEN ?? '',
    env.INTERNAL_WEBHOOK_SECRET ?? '',
    env.WEBHOOK_POLL_ENABLED ?? '',
    env.AGENTS_API_BASE_URL ?? DEFAULT_AGENTS_API_BASE_URL,
    env.AGENTS_API_TIMEOUT_MS ?? `${DEFAULT_TIMEOUT_MS}`,
    env.AGENTS_API_MAX_PAGES ?? `${DEFAULT_MAX_PAGES}`,
  ].join('|')

  const cached = webhookManagerCache.get(cacheKey)
  if (cached) {
    return cached
  }

  const manager = createWebhookManager({
    databaseUrl: env.TURSO_DATABASE_URL,
    authToken: env.TURSO_AUTH_TOKEN,
    agentsClient: {
      listApprovedEstablishments: ({ baseUrl, timeoutMs, maxPages }) =>
        fetchEstablishments({ baseUrl, timeoutMs, maxPages }),
    },
    agentsBaseUrl: env.AGENTS_API_BASE_URL ?? DEFAULT_AGENTS_API_BASE_URL,
    agentsTimeoutMs: positiveInteger(env.AGENTS_API_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    agentsMaxPages: positiveInteger(env.AGENTS_API_MAX_PAGES, DEFAULT_MAX_PAGES),
    internalWebhookSecret: env.INTERNAL_WEBHOOK_SECRET || null,
    pollEnabled: env.WEBHOOK_POLL_ENABLED !== 'false',
  })

  webhookManagerCache.set(cacheKey, manager)
  return manager
}

function presentSubscription(
  subscription: Awaited<ReturnType<WebhookManager['createSubscription']>>,
  { includeToken = false }: { includeToken?: boolean } = {}
) {
  const payload = {
    id: subscription.id,
    name: subscription.name,
    description: subscription.description,
    callbackUrl: subscription.callbackUrl,
    enabled: subscription.enabled,
    createdAt: subscription.createdAt,
    updatedAt: subscription.updatedAt,
    lastDeliveryAt: subscription.lastDeliveryAt,
    lastStatus: subscription.lastStatus,
    webhookTokenPreview: subscription.token
      ? `${subscription.token.slice(0, 8)}...${subscription.token.slice(-6)}`
      : null,
  }

  if (includeToken) {
    return {
      ...payload,
      webhookToken: subscription.token,
      webhookTokenType: 'Bearer',
    }
  }

  return payload
}

function createWebhookPayload(body: unknown) {
  if (!body || typeof body !== 'object') {
    throw new ApiError(400, 'JSON invalido para webhook.')
  }

  const source = body as Record<string, unknown>

  if (typeof source.callbackUrl !== 'string' || !source.callbackUrl.trim()) {
    throw new ApiError(400, 'callbackUrl e obrigatorio.')
  }

  return {
    callbackUrl: source.callbackUrl,
    name: typeof source.name === 'string' ? source.name : null,
    description: typeof source.description === 'string' ? source.description : null,
  }
}

const app = new Hono<{ Bindings: AppEnv }>()

app.onError((error, c) => {
  const apiError = error instanceof ApiError ? error : new ApiError(500, 'Erro interno ao processar a requisicao.')
  return new Response(
    JSON.stringify({
      error: {
        message: apiError.message,
        statusCode: apiError.statusCode,
        requestId: crypto.randomUUID(),
      },
    }),
    {
      status: apiError.statusCode,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      },
    }
  )
})

app.notFound((c) =>
  c.json(
    {
      error: {
        message: 'Rota nao encontrada.',
        statusCode: 404,
        requestId: crypto.randomUUID(),
      },
    },
    404,
    { 'cache-control': 'no-store' }
  )
)

app.get('/health', (c) =>
  c.json(
    {
      ok: true,
      service: 'api-adquirencia',
      timestamp: new Date().toISOString(),
    },
    200,
    { 'cache-control': 'no-store' }
  )
)

app.get('/openapi.json', (c) =>
  c.json(buildOpenApiSpec({ baseUrl: c.env.WEBHOOK_PUBLIC_BASE_URL ?? DEFAULT_WEBHOOK_BASE_URL }), 200, {
    'cache-control': 'no-store',
  })
)

app.get('/leads/credit', (c) => c.html(renderCreditDashboard(), 200, {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
}))

app.get('/assets/credit-leads.js', (c) => c.body(creditDashboardScript, 200, {
  'content-type': 'text/javascript; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
}))

app.get('/docs/credit-leads', (c) => c.html(renderCreditDocs(), 200, { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }))

app.get('/docs', (c) => {
  return new Response(renderDocsHtml({ specUrl: '/openapi.json' }), {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
})

app.get(
  '/api/establishments',
  requireApiKey,
  async (c) => {
    const items = await fetchEstablishments({
      baseUrl: c.env.AGENTS_API_BASE_URL ?? DEFAULT_AGENTS_API_BASE_URL,
      timeoutMs: positiveInteger(c.env.AGENTS_API_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
      maxPages: positiveInteger(c.env.AGENTS_API_MAX_PAGES, DEFAULT_MAX_PAGES),
    })

    const establishments = items.map((item) => normalizeEstablishment(item)).filter((item) => isApprovedEstablishment(item))

    return c.json(
      {
        data: establishments,
        meta: {
          total: establishments.length,
          source: 'agents-api',
          filtered: 'approved-only',
        },
      },
      200,
      { 'cache-control': 'no-store' }
    )
  }
)

app.get(
  '/api/establishments/:id',
  requireApiKey,
  async (c) => {
    const establishment = normalizeEstablishment(
      await fetchEstablishmentById({
        baseUrl: c.env.AGENTS_API_BASE_URL ?? DEFAULT_AGENTS_API_BASE_URL,
        id: c.req.param('id'),
        timeoutMs: positiveInteger(c.env.AGENTS_API_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
      })
    )

    if (!isApprovedEstablishment(establishment)) {
      throw new ApiError(404, 'Estabelecimento nao encontrado.')
    }

    return c.json(
      {
        data: establishment,
        meta: {
          source: 'agents-api',
        },
      },
      200,
      { 'cache-control': 'no-store' }
    )
  }
)

app.get(
  '/api/webhooks/subscriptions',
  requireApiKey,
  async (c) => {
    const manager = resolveWebhookManager(c.env)
    const subscriptions = await manager.listSubscriptions()
    return c.json(
      {
        data: subscriptions.map((subscription) => presentSubscription(subscription)),
        meta: {
          total: subscriptions.length,
        },
      },
      200,
      { 'cache-control': 'no-store' }
    )
  }
)

app.post(
  '/api/webhooks/subscriptions',
  requireApiKey,
  async (c) => {
    const body = await c.req.json().catch(() => null)
    const payload = createWebhookPayload(body)
    const manager = resolveWebhookManager(c.env)
    const subscription = await manager.createSubscription(payload)

    return c.json(
      {
        data: presentSubscription(subscription, { includeToken: true }),
        meta: {
          note: 'Guarde o webhookToken com seguranca. Ele e exibido apenas nesta criacao.',
        },
      },
      201,
      {
        location: `/api/webhooks/subscriptions/${subscription.id}`,
        'cache-control': 'no-store',
      }
    )
  }
)

app.get(
  '/api/webhooks/subscriptions/:id',
  requireApiKey,
  async (c) => {
    const manager = resolveWebhookManager(c.env)
    const subscription = await manager.getSubscription(c.req.param('id'))

    if (!subscription) {
      throw new ApiError(404, 'Assinatura nao encontrada.')
    }

    return c.json({ data: presentSubscription(subscription) }, 200, { 'cache-control': 'no-store' })
  }
)

app.delete(
  '/api/webhooks/subscriptions/:id',
  requireApiKey,
  async (c) => {
    const manager = resolveWebhookManager(c.env)
    const subscription = await manager.disableSubscription(c.req.param('id'))

    return c.json({ data: presentSubscription(subscription) }, 200, { 'cache-control': 'no-store' })
  }
)

app.get(
  '/api/webhooks/deliveries',
  requireApiKey,
  async (c) => {
    const manager = resolveWebhookManager(c.env)
    const deliveries = await manager.listDeliveries()

    return c.json(
      {
        data: deliveries,
        meta: {
          total: deliveries.length,
        },
      },
      200,
      { 'cache-control': 'no-store' }
    )
  }
)

app.get(
  '/api/webhooks/deliveries/:id',
  requireApiKey,
  async (c) => {
    const manager = resolveWebhookManager(c.env)
    const delivery = await manager.getDelivery(c.req.param('id'))

    if (!delivery) {
      throw new ApiError(404, 'Entrega nao encontrada.')
    }

    return c.json({ data: delivery }, 200, { 'cache-control': 'no-store' })
  }
)

app.post('/api/webhooks/events/establishment-approved', async (c) => {
  const body = await c.req.json().catch(() => null)
  const manager = resolveWebhookManager(c.env)
  await manager.handleInternalApprovedEvent(c.req.header('x-internal-webhook-secret') ?? undefined, body)

  return c.json(
    {
      ok: true,
      message: 'Evento processado com sucesso.',
    },
    200,
    { 'cache-control': 'no-store' }
  )
})

app.route('/', createCreditRoutes())

export const scheduled = async (_event: ScheduledEvent, env: AppEnv, ctx: ExecutionContext) => {
  if (env.WEBHOOK_POLL_ENABLED === 'false') {
    return
  }

  const manager = resolveWebhookManager(env)
  ctx.waitUntil(manager.syncApprovedEstablishments({ source: 'cron' }))
}

export default app
