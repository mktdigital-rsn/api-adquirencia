import { createClient, type Client } from '@libsql/client/web'

import { ApiError } from './errors'
import { isApprovedEstablishment, normalizeEstablishment } from './normalize'

type JsonRecord = Record<string, unknown>

type WebhookSubscription = {
  id: string
  token: string
  name: string | null
  description: string | null
  callbackUrl: string
  enabled: boolean
  createdAt: string
  updatedAt: string
  lastDeliveryAt: string | null
  lastStatus: string | null
}

type WebhookDelivery = {
  id: string
  subscriptionId: string
  callbackUrl: string
  event: string
  source: string
  statusCode: number
  ok: boolean
  responseBody: string
  responseHeaders: JsonRecord
  requestBody: JsonRecord
  createdAt: string
}

type SyncState = {
  initialized: boolean
  lastApprovedIds: string[]
  lastPollAt: string | null
}

type AgentsClient = {
  listApprovedEstablishments: (options: { baseUrl: string; timeoutMs: number; maxPages: number }) => Promise<unknown[]>
}

type WebhookManagerOptions = {
  databaseUrl?: string
  authToken?: string
  agentsClient: AgentsClient
  fetchImpl?: typeof fetch
  now?: () => Date
  uuid?: () => string
  pollEnabled?: boolean
  internalWebhookSecret?: string | null
  agentsBaseUrl: string
  agentsTimeoutMs: number
  agentsMaxPages: number
}

async function hmacSha256Hex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value))
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function normalizeCallbackUrl(callbackUrl: string): string {
  if (typeof callbackUrl !== 'string' || !callbackUrl.trim()) {
    throw new ApiError(400, 'callbackUrl e obrigatorio.')
  }

  let parsed: URL
  try {
    parsed = new URL(callbackUrl.trim())
  } catch {
    throw new ApiError(400, 'callbackUrl invalida.')
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new ApiError(400, 'callbackUrl deve usar http ou https.')
  }

  return parsed.toString()
}

function asString(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') return String(value)
  return fallback
}

function asNullableString(value: unknown): string | null {
  const text = asString(value).trim()
  return text ? text : null
}

function asBoolean(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true'
}

function asNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function parseJsonValue(value: unknown): JsonRecord | unknown[] | null {
  if (value == null) return null
  if (typeof value === 'object') return value as JsonRecord
  if (typeof value !== 'string' || !value.trim()) return null

  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function rowToSubscription(row: JsonRecord): WebhookSubscription {
  return {
    id: asString(row.id),
    token: asString(row.token),
    name: asNullableString(row.name),
    description: asNullableString(row.description),
    callbackUrl: asString(row.callback_url),
    enabled: asBoolean(row.enabled),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
    lastDeliveryAt: asNullableString(row.last_delivery_at),
    lastStatus: asNullableString(row.last_status),
  }
}

function rowToDelivery(row: JsonRecord): WebhookDelivery {
  return {
    id: asString(row.id),
    subscriptionId: asString(row.subscription_id),
    callbackUrl: asString(row.callback_url),
    event: asString(row.event),
    source: asString(row.source),
    statusCode: asNumber(row.status_code),
    ok: asBoolean(row.ok),
    responseBody: asString(row.response_body),
    responseHeaders: (parseJsonValue(row.response_headers_json) as JsonRecord | null) ?? {},
    requestBody: (parseJsonValue(row.request_body_json) as JsonRecord | null) ?? {},
    createdAt: asString(row.created_at),
  }
}

export type PresentableWebhookSubscription = WebhookSubscription
export type PresentableWebhookDelivery = WebhookDelivery

export function createWebhookManager(options: WebhookManagerOptions) {
  const {
    databaseUrl,
    authToken,
    agentsClient,
    fetchImpl = fetch,
    now = () => new Date(),
    uuid = () => crypto.randomUUID(),
    pollEnabled = true,
    internalWebhookSecret = null,
    agentsBaseUrl,
    agentsTimeoutMs,
    agentsMaxPages,
  } = options

  let client: Client | null = null
  let schemaReady: Promise<void> | null = null

  function getClient(): Client {
    if (!databaseUrl) {
      throw new ApiError(500, 'Banco de webhooks nao configurado.')
    }

    if (!client) {
      client = createClient({ url: databaseUrl, authToken, fetch: fetchImpl })
    }

    return client
  }

  async function ensureSchema(): Promise<void> {
    if (!schemaReady) {
      schemaReady = (async () => {
        const db = getClient()
        await db.executeMultiple(`
          CREATE TABLE IF NOT EXISTS webhook_subscriptions (
            id TEXT PRIMARY KEY,
            token TEXT NOT NULL,
            name TEXT,
            description TEXT,
            callback_url TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            last_delivery_at TEXT,
            last_status TEXT
          );

          CREATE TABLE IF NOT EXISTS webhook_deliveries (
            id TEXT PRIMARY KEY,
            subscription_id TEXT NOT NULL,
            callback_url TEXT NOT NULL,
            event TEXT NOT NULL,
            source TEXT NOT NULL,
            status_code INTEGER NOT NULL,
            ok INTEGER NOT NULL,
            response_body TEXT NOT NULL,
            response_headers_json TEXT NOT NULL,
            request_body_json TEXT NOT NULL,
            created_at TEXT NOT NULL
          );

          CREATE TABLE IF NOT EXISTS webhook_sync_state (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            initialized INTEGER NOT NULL DEFAULT 0,
            last_approved_ids_json TEXT NOT NULL DEFAULT '[]',
            last_poll_at TEXT
          );

          INSERT OR IGNORE INTO webhook_sync_state (id, initialized, last_approved_ids_json, last_poll_at)
          VALUES (1, 0, '[]', NULL);
        `)
      })().catch((error: unknown) => {
        schemaReady = null
        throw error instanceof ApiError
          ? error
          : new ApiError(502, 'Nao foi possivel inicializar o banco de webhooks.')
      })
    }

    await schemaReady
  }

  async function loadSyncState(): Promise<SyncState> {
    await ensureSchema()
    const result = await getClient().execute('SELECT initialized, last_approved_ids_json, last_poll_at FROM webhook_sync_state WHERE id = 1')
    const row = result.rows[0] as JsonRecord | undefined

    return {
      initialized: asBoolean(row?.initialized),
      lastApprovedIds: (() => {
        const raw = parseJsonValue(row?.last_approved_ids_json)
        return Array.isArray(raw) ? raw.map((value) => asString(value)).filter(Boolean) : []
      })(),
      lastPollAt: asNullableString(row?.last_poll_at),
    }
  }

  async function saveSyncState(state: SyncState): Promise<void> {
    await ensureSchema()
    await getClient().execute({
      sql: `
        UPDATE webhook_sync_state
        SET initialized = ?, last_approved_ids_json = ?, last_poll_at = ?
        WHERE id = 1
      `,
      args: [state.initialized ? 1 : 0, JSON.stringify(state.lastApprovedIds), state.lastPollAt],
    })
  }

  async function getSubscription(id: string): Promise<WebhookSubscription | null> {
    await ensureSchema()
    const result = await getClient().execute({
      sql: `
        SELECT
          id, token, name, description, callback_url, enabled, created_at, updated_at, last_delivery_at, last_status
        FROM webhook_subscriptions
        WHERE id = ?
        LIMIT 1
      `,
      args: [id],
    })

    const row = result.rows[0] as JsonRecord | undefined
    return row ? rowToSubscription(row) : null
  }

  async function listSubscriptions(): Promise<WebhookSubscription[]> {
    await ensureSchema()
    const result = await getClient().execute(`
      SELECT
        id, token, name, description, callback_url, enabled, created_at, updated_at, last_delivery_at, last_status
      FROM webhook_subscriptions
      ORDER BY created_at DESC
    `)
    return result.rows.map((row) => rowToSubscription(row as JsonRecord))
  }

  async function createSubscription({
    callbackUrl,
    name = null,
    description = null,
  }: {
    callbackUrl: string
    name?: string | null
    description?: string | null
  }): Promise<WebhookSubscription> {
    await ensureSchema()
    const subscription: WebhookSubscription = {
      id: uuid(),
      token: uuid(),
      name: name && name.trim() ? name.trim() : null,
      description: description && description.trim() ? description.trim() : null,
      callbackUrl: normalizeCallbackUrl(callbackUrl),
      enabled: true,
      createdAt: now().toISOString(),
      updatedAt: now().toISOString(),
      lastDeliveryAt: null,
      lastStatus: null,
    }

    await getClient().execute({
      sql: `
        INSERT INTO webhook_subscriptions (
          id, token, name, description, callback_url, enabled, created_at, updated_at, last_delivery_at, last_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        subscription.id,
        subscription.token,
        subscription.name,
        subscription.description,
        subscription.callbackUrl,
        1,
        subscription.createdAt,
        subscription.updatedAt,
        subscription.lastDeliveryAt,
        subscription.lastStatus,
      ],
    })

    return subscription
  }

  async function disableSubscription(id: string): Promise<WebhookSubscription> {
    await ensureSchema()
    const timestamp = now().toISOString()
    const result = await getClient().execute({
      sql: `
        UPDATE webhook_subscriptions
        SET enabled = 0, updated_at = ?
        WHERE id = ?
        RETURNING id, token, name, description, callback_url, enabled, created_at, updated_at, last_delivery_at, last_status
      `,
      args: [timestamp, id],
    })

    const row = result.rows[0] as JsonRecord | undefined
    if (!row) {
      throw new ApiError(404, 'Assinatura nao encontrada.')
    }

    return rowToSubscription(row)
  }

  async function listDeliveries(): Promise<WebhookDelivery[]> {
    await ensureSchema()
    const result = await getClient().execute(`
      SELECT
        id, subscription_id, callback_url, event, source, status_code, ok, response_body, response_headers_json, request_body_json, created_at
      FROM webhook_deliveries
      ORDER BY created_at DESC
      LIMIT 500
    `)
    return result.rows.map((row) => rowToDelivery(row as JsonRecord))
  }

  async function getDelivery(id: string): Promise<WebhookDelivery | null> {
    await ensureSchema()
    const result = await getClient().execute({
      sql: `
        SELECT
          id, subscription_id, callback_url, event, source, status_code, ok, response_body, response_headers_json, request_body_json, created_at
        FROM webhook_deliveries
        WHERE id = ?
        LIMIT 1
      `,
      args: [id],
    })
    const row = result.rows[0] as JsonRecord | undefined
    return row ? rowToDelivery(row) : null
  }

  async function recordDelivery(delivery: Omit<WebhookDelivery, 'responseHeaders' | 'requestBody'> & { responseHeaders: JsonRecord; requestBody: JsonRecord }): Promise<WebhookDelivery> {
    await ensureSchema()
    await getClient().execute({
      sql: `
        INSERT INTO webhook_deliveries (
          id, subscription_id, callback_url, event, source, status_code, ok, response_body, response_headers_json, request_body_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        delivery.id,
        delivery.subscriptionId,
        delivery.callbackUrl,
        delivery.event,
        delivery.source,
        delivery.statusCode,
        delivery.ok ? 1 : 0,
        delivery.responseBody,
        JSON.stringify(delivery.responseHeaders ?? {}),
        JSON.stringify(delivery.requestBody ?? {}),
        delivery.createdAt,
      ],
    })

    return delivery as WebhookDelivery
  }

  async function updateSubscriptionDeliveryStatus(subscriptionId: string, timestamp: string, ok: boolean): Promise<void> {
    await ensureSchema()
    await getClient().execute({
      sql: `
        UPDATE webhook_subscriptions
        SET last_delivery_at = ?, last_status = ?, updated_at = ?
        WHERE id = ?
      `,
      args: [timestamp, ok ? 'delivered' : 'failed', timestamp, subscriptionId],
    })
  }

  async function sendWebhook(subscription: WebhookSubscription, establishment: JsonRecord, eventName: string, source: string): Promise<WebhookDelivery> {
    const deliveryId = uuid()
    const timestamp = now().toISOString()
    const payload = {
      id: deliveryId,
      event: eventName,
      source,
      timestamp,
      subscriptionId: subscription.id,
      establishment,
    }

    const body = JSON.stringify(payload)
    const signature = await hmacSha256Hex(subscription.token, body)

    try {
      const response = await fetchImpl(subscription.callbackUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json; charset=utf-8',
          authorization: `Bearer ${subscription.token}`,
          'x-g8-webhook-id': deliveryId,
          'x-g8-webhook-event': eventName,
          'x-g8-webhook-subscription-id': subscription.id,
          'x-g8-webhook-signature': `sha256=${signature}`,
          'x-g8-webhook-timestamp': timestamp,
        },
        body,
      })

      const responseBody = await response.text()
      const delivery: WebhookDelivery = {
        id: deliveryId,
        subscriptionId: subscription.id,
        callbackUrl: subscription.callbackUrl,
        event: eventName,
        source,
        statusCode: response.status,
        ok: response.ok,
        responseBody: responseBody.slice(0, 2000),
        responseHeaders: response.headers ? Object.fromEntries(response.headers.entries()) : {},
        requestBody: payload,
        createdAt: timestamp,
      }

      await recordDelivery(delivery)
      await updateSubscriptionDeliveryStatus(subscription.id, timestamp, response.ok)
      return delivery
    } catch (error) {
      const delivery: WebhookDelivery = {
        id: deliveryId,
        subscriptionId: subscription.id,
        callbackUrl: subscription.callbackUrl,
        event: eventName,
        source,
        statusCode: 0,
        ok: false,
        responseBody: error instanceof Error ? error.message : 'Falha ao enviar webhook.',
        responseHeaders: {},
        requestBody: payload,
        createdAt: timestamp,
      }

      await recordDelivery(delivery)
      await updateSubscriptionDeliveryStatus(subscription.id, timestamp, false)
      return delivery
    }
  }

  async function dispatchApprovedEstablishment(establishment: JsonRecord, source = 'cron'): Promise<WebhookDelivery[]> {
    await ensureSchema()
    const subscriptions = (await listSubscriptions()).filter((subscription) => subscription.enabled)
    const deliveries: WebhookDelivery[] = []

    for (const subscription of subscriptions) {
      deliveries.push(await sendWebhook(subscription, establishment, 'establishment.approved', source))
    }

    return deliveries
  }

  async function syncApprovedEstablishments({ source = 'cron' }: { source?: string } = {}): Promise<{ newApprovals: JsonRecord[]; totalApproved: number }> {
    if (!pollEnabled) {
      return { newApprovals: [], totalApproved: 0 }
    }

    const state = await loadSyncState()
    const approved = await agentsClient.listApprovedEstablishments({
      baseUrl: agentsBaseUrl,
      timeoutMs: agentsTimeoutMs,
      maxPages: agentsMaxPages,
    })
    const normalized = approved
      .map((item) => normalizeEstablishment(item))
      .filter((item) => isApprovedEstablishment(item))

    const approvedIds = normalized.map((item) => asString(item.id)).filter(Boolean)

    if (!state.initialized) {
      await saveSyncState({
        initialized: true,
        lastApprovedIds: approvedIds,
        lastPollAt: now().toISOString(),
      })

      return {
        newApprovals: [],
        totalApproved: approvedIds.length,
      }
    }

    const previousIds = new Set(state.lastApprovedIds)
    const newApprovals = normalized.filter((item) => {
      const id = asString(item.id)
      return id && !previousIds.has(id)
    }) as JsonRecord[]

    for (const establishment of newApprovals) {
      await dispatchApprovedEstablishment(establishment, source)
    }

    await saveSyncState({
      initialized: true,
      lastApprovedIds: approvedIds,
      lastPollAt: now().toISOString(),
    })

    return {
      newApprovals,
      totalApproved: approvedIds.length,
    }
  }

  async function processIncomingApprovalEvent(establishment: unknown, source = 'incoming'): Promise<{ ok: true }> {
    const normalized = normalizeEstablishment(establishment)

    if (!isApprovedEstablishment(normalized)) {
      throw new ApiError(400, 'O evento precisa representar um estabelecimento aprovado.')
    }

    await dispatchApprovedEstablishment(normalized as JsonRecord, source)

    const state = await loadSyncState()
    const id = asString(normalized.id)
    if (id && !state.lastApprovedIds.includes(id)) {
      state.lastApprovedIds.push(id)
      state.lastPollAt = now().toISOString()
      state.initialized = true
      await saveSyncState(state)
    }

    return { ok: true }
  }

  function validateInternalSecret(providedSecret: string | undefined): void {
    if (!internalWebhookSecret) {
      throw new ApiError(503, 'Webhook interno nao configurado.')
    }

    if (providedSecret !== internalWebhookSecret) {
      throw new ApiError(401, 'Webhook interno nao autorizado.')
    }
  }

  async function handleInternalApprovedEvent(providedSecret: string | undefined, body: unknown): Promise<{ ok: true }> {
    validateInternalSecret(providedSecret)
    const establishment = body && typeof body === 'object' && 'establishment' in body
      ? (body as JsonRecord).establishment ?? (body as JsonRecord).data ?? body
      : body

    return processIncomingApprovalEvent(establishment, 'internal-webhook')
  }

  return {
    listSubscriptions,
    getSubscription,
    createSubscription,
    disableSubscription,
    listDeliveries,
    getDelivery,
    syncApprovedEstablishments,
    processIncomingApprovalEvent,
    handleInternalApprovedEvent,
    dispatchApprovedEstablishment,
  }
}
