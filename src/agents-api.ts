import { ApiError } from './errors'

type JsonRecord = Record<string, unknown>

function buildUrl(baseUrl: string, path: string, searchParams?: URLSearchParams): URL {
  const url = new URL(path, baseUrl)
  searchParams?.forEach((value, key) => url.searchParams.set(key, value))
  return url
}

async function fetchJson(url: URL, timeoutMs: number): Promise<unknown> {
  const response = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) }).catch((error: unknown) => {
    if (error instanceof DOMException && error.name === 'TimeoutError') throw new ApiError(504, 'Tempo limite excedido ao consultar a API de agentes.')
    throw new ApiError(502, 'Nao foi possivel consultar a API de agentes.')
  })

  const raw = await response.text()
  let body: unknown = null
  if (raw) {
    try { body = JSON.parse(raw) } catch { throw new ApiError(502, 'A API de agentes retornou um payload invalido.', { upstreamStatus: response.status }) }
  }

  if (!response.ok) {
    const payload = body as JsonRecord | null
    const error = payload?.error as JsonRecord | undefined
    const message = typeof payload?.message === 'string' ? payload.message : typeof error?.message === 'string' ? error.message : 'Falha ao consultar a API de agentes.'
    throw new ApiError(response.status >= 500 ? 502 : response.status, message, { upstreamStatus: response.status })
  }

  return body
}

function extractListPayload(payload: unknown): { items: unknown[]; nextToken: string | null; nextTokenParamName: string | null } {
  if (Array.isArray(payload)) return { items: payload, nextToken: null, nextTokenParamName: null }
  if (!payload || typeof payload !== 'object') return { items: [], nextToken: null, nextTokenParamName: null }

  const source = payload as JsonRecord
  const items = [source.data, source.items, source.establishments, source.results, source.records].find(Array.isArray) as unknown[] | undefined
  const nextPageToken = typeof source.nextPageToken === 'string' ? source.nextPageToken : null
  const cursor = typeof source.nextCursor === 'string' ? source.nextCursor : typeof source.cursor === 'string' ? source.cursor : null
  const pageToken = typeof source.pageToken === 'string' ? source.pageToken : null

  return { items: items ?? [], nextToken: nextPageToken ?? cursor ?? pageToken, nextTokenParamName: nextPageToken || pageToken ? 'pageToken' : cursor ? 'cursor' : null }
}

export async function fetchEstablishments({ baseUrl, timeoutMs, maxPages }: { baseUrl: string; timeoutMs: number; maxPages: number }): Promise<unknown[]> {
  const items: unknown[] = []
  let pageToken: string | null = null
  let pageTokenParamName = 'pageToken'
  for (let page = 0; page < maxPages; page += 1) {
    const searchParams = pageToken ? new URLSearchParams({ [pageTokenParamName]: pageToken }) : undefined
    const pageData = extractListPayload(await fetchJson(buildUrl(baseUrl, '/api/establishments', searchParams), timeoutMs))
    items.push(...pageData.items)
    if (!pageData.nextToken || pageData.nextToken === pageToken) break
    pageToken = pageData.nextToken
    pageTokenParamName = pageData.nextTokenParamName ?? pageTokenParamName
  }
  return items
}

export async function fetchEstablishmentById({ baseUrl, id, timeoutMs }: { baseUrl: string; id: string; timeoutMs: number }): Promise<unknown> {
  if (!id) throw new ApiError(400, 'Identificador do estabelecimento ausente.')
  const payload = await fetchJson(buildUrl(baseUrl, `/api/establishments/${encodeURIComponent(id)}`), timeoutMs)
  if (!payload || typeof payload !== 'object') throw new ApiError(502, 'Resposta invalida da API de agentes.')
  const source = payload as JsonRecord
  return source.data ?? source.item ?? source.establishment ?? source
}

export async function listApprovedEstablishments({ baseUrl, timeoutMs, maxPages }: { baseUrl: string; timeoutMs: number; maxPages: number }): Promise<unknown[]> {
  const items = await fetchEstablishments({ baseUrl, timeoutMs, maxPages })
  return items.filter((item) => {
    if (!item || typeof item !== 'object') return false
    const source = item as JsonRecord
    const approved = source.approved === true
      || source.isApproved === true
      || ['approved', 'aprovado'].includes(String(source.status ?? source.approvalStatus ?? '').trim().toLowerCase())
    return approved
  })
}
