export class CreditError extends Error {
  constructor(public status: 401 | 403 | 404 | 409 | 413 | 422 | 503, message: string) { super(message) }
}
export const invalid = () => new CreditError(422, 'Invalid request contract or parameters')
export const producer = 'bankwhitelabel-server'
export const origins = ['PUBLICA', 'AGENTE', 'IB']
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid()
  return value as Record<string, unknown>
}
export function exact(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).some(k => !keys.includes(k))) throw invalid()
}
export function string(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.length || value.length > max) throw invalid()
  return value
}
export function timestamp(value: unknown): string {
  const text = string(value, 100)
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(text)
  if (!match) throw invalid()
  const [, y, m, d, h, min, s, , zone] = match
  const days = new Date(Date.UTC(+y!, +m!, 0)).getUTCDate()
  if (+m! < 1 || +m! > 12 || +d! < 1 || +d! > days || +h! > 23 || +min! > 59 || +s! > 59 || (zone !== 'Z' && (+zone!.slice(1,3) > 23 || +zone!.slice(4) > 59))) throw invalid()
  const date = new Date(text)
  if (!Number.isFinite(date.getTime())) throw invalid()
  return date.toISOString().replace(/\.\d{3}Z$/, '.' + (match[7] ?? '').padEnd(9, '0') + 'Z')
}
export function normalizeEvent(input: unknown) {
  const e = object(input)
  exact(e, ['eventId', 'eventType', 'schemaVersion', 'occurredAt', 'producer', 'data'])
  const eventId = string(e.eventId, 36).toLowerCase()
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(eventId) || e.eventType !== 'credit.lead.created' || e.schemaVersion !== 1 || e.producer !== producer) throw invalid()
  const d = object(e.data)
  exact(d, ['leadId','origem','status','amount','createdAt','userId','name','taxNumber','email','phoneNumber','userKind','agentId'])
  const amount = string(d.amount, 100)
  if (!/^\d+(\.\d+)?$/.test(amount) || !/[1-9]/.test(amount) || !origins.includes(d.origem as string) || d.status !== 'PENDENTE') throw invalid()
  const userId = d.userId ?? null
  if (userId !== null && (typeof userId !== 'number' || !Number.isSafeInteger(userId))) throw invalid()
  const optional = (key: string, max: number) => {
    const v = d[key] ?? null
    if (v !== null && (typeof v !== 'string' || v.length > max)) throw invalid()
    return v as string | null
  }
  if (d.userKind != null && !['PF','PJ'].includes(d.userKind as string)) throw invalid()
  return { eventId, eventType: 'credit.lead.created', schemaVersion: 1, occurredAt: timestamp(e.occurredAt), producer,
    data: { leadId: string(d.leadId,128), origem: d.origem as string, status: 'PENDENTE', amount, createdAt: timestamp(d.createdAt), userId,
      name: optional('name',500), taxNumber: optional('taxNumber',100), email: optional('email',320), phoneNumber: optional('phoneNumber',100), userKind: (d.userKind ?? null) as string | null, agentId: optional('agentId',255) } }
}
export type CreditEvent = ReturnType<typeof normalizeEvent>
// Objects have a fixed schema and construction order, including all optional nulls.
export const canonicalEvent = (input: unknown) => JSON.stringify(normalizeEvent(input))
