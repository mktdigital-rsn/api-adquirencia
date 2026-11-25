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
export function birthDate(value: unknown): string | null {
  if (value == null) return null
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw invalid()
  const [year, month, day] = value.split('-').map(Number)
  const leap = year! % 4 === 0 && (year! % 100 !== 0 || year! % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (month! < 1 || month! > 12 || day! < 1 || day! > days[month! - 1]!) throw invalid()
  return value
}

export function normalizeCreatedEvent(input: unknown) {
  const e = object(input)
  exact(e, ['eventId', 'eventType', 'schemaVersion', 'occurredAt', 'producer', 'data'])
  const eventId = string(e.eventId, 36).toLowerCase()
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(eventId) || e.eventType !== 'credit.lead.created' || e.schemaVersion !== 1 || e.producer !== producer) throw invalid()
  const d = object(e.data)
  exact(d, ['leadId','origem','status','amount','createdAt','userId','name','taxNumber','email','phoneNumber','userKind','agentId','birthDate'])
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
  return { eventId, eventType: 'credit.lead.created' as const, schemaVersion: 1, occurredAt: timestamp(e.occurredAt), producer,
    data: { leadId: string(d.leadId,128), origem: d.origem as string, status: 'PENDENTE', amount, createdAt: timestamp(d.createdAt), userId,
      birthDate: birthDate(d.birthDate), name: optional('name',500), taxNumber: optional('taxNumber',100), email: optional('email',320), phoneNumber: optional('phoneNumber',100), userKind: (d.userKind ?? null) as string | null, agentId: optional('agentId',255) } }
}
function envelope(input: unknown, eventType: string) {
  const e = object(input)
  exact(e, ['eventId','eventType','schemaVersion','occurredAt','producer','data'])
  const eventId = string(e.eventId,36).toLowerCase()
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(eventId) || e.eventType !== eventType || e.schemaVersion !== 1 || e.producer !== producer) throw invalid()
  return {eventId, schemaVersion:1, occurredAt:timestamp(e.occurredAt), producer}
}
const contactKeys = ['leadId','origem','name','email','taxNumber','phoneNumber']
function contact(d: Record<string,unknown>, legacy = false) {
  const optional = (key:string,max:number) => {
    const value=d[key] ?? null
    if(value!==null && (typeof value!=='string' || value.length>max))throw invalid()
    return value as string|null
  }
  if (!legacy && !origins.includes(d.origem as string)) throw invalid()
  const phoneNumber=legacy?optional('phoneNumber',100):string(d.phoneNumber,100)
  if (!legacy && !phoneNumber!.trim())throw invalid()
  return {leadId:string(d.leadId,128),origem:legacy?null:d.origem as string,
    name:optional('name',500),email:optional('email',320),taxNumber:optional('taxNumber',100),phoneNumber}
}
function timing(d: Record<string,unknown>, documents: boolean, legacy = false) {
  const reminderNumber=d.reminderNumber ?? (legacy?1:undefined)
  if(reminderNumber!==1 && reminderNumber!==2)throw invalid()
  const thresholdHours=d.thresholdHours
  if(typeof thresholdHours!=='number' || !Number.isSafeInteger(thresholdHours) || thresholdHours<0 || thresholdHours>8760)throw invalid()
  if(documents && !legacy && thresholdHours!==(reminderNumber===1?0:48))throw invalid()
  if(!documents && (reminderNumber===1?thresholdHours!==24:thresholdHours<=24))throw invalid()
  const requestedAt=timestamp(d.requestedAt),dueAt=timestamp(d.dueAt)
  if(!legacy && Date.parse(dueAt)-Date.parse(requestedAt)!==thresholdHours*3600000)throw invalid()
  return {requestedAt,dueAt,thresholdHours,reminderNumber,message:string(d.message,2000)}
}
export function normalizeDocumentsOverdueEvent(input: unknown) {
  const env=envelope(input,'credit.lead.documents.overdue'),d=object(object(input).data)
  exact(d,[...contactKeys,'collectionLinkId','status','requestedAt','dueAt','expiresAt','thresholdHours','reminderNumber','message'])
  // Read already persisted v1 events during rolling deployment; new cadence is explicit.
  const legacy=d.thresholdHours===24 && d.origem==null && d.phoneNumber==null && (d.reminderNumber??1)===1
  const common=contact(d,legacy),dates=timing(d,true,legacy),expiresAt=timestamp(d.expiresAt)
  if(!legacy && Date.parse(expiresAt)<=Date.parse(dates.dueAt))throw invalid()
  return {...env,eventType:'credit.lead.documents.overdue' as const,data:{...common,
    collectionLinkId:string(d.collectionLinkId,128),status:string(d.status,50),...dates,expiresAt}}
}
export function normalizeApprovedEvent(input: unknown) {
  const env=envelope(input,'credit.lead.approved'),d=object(object(input).data)
  exact(d,[...contactKeys,'status'])
  return {...env,eventType:'credit.lead.approved' as const,data:{...contact(d),status:string(d.status,50)}}
}
export function normalizeSignatureOverdueEvent(input: unknown) {
  const env=envelope(input,'credit.lead.signature.overdue'),d=object(object(input).data)
  exact(d,[...contactKeys,'ccbId','status','requestedAt','dueAt','thresholdHours','reminderNumber','message'])
  return {...env,eventType:'credit.lead.signature.overdue' as const,data:{...contact(d),
    ccbId:string(d.ccbId,128),status:string(d.status,50),...timing(d,false)}}
}
export function normalizeResolvedEvent(input: unknown) {
  const env=envelope(input,'credit.lead.reminders.resolved'),d=object(object(input).data)
  exact(d,[...contactKeys,'kind','referenceId','resolvedAt','reason'])
  if(d.kind!=='documents' && d.kind!=='signature')throw invalid()
  if(!['received','signed','cancelled','superseded','expired','rejected'].includes(d.reason as string))throw invalid()
  return {...env,eventType:'credit.lead.reminders.resolved' as const,data:{...contact(d),
    kind:d.kind as 'documents'|'signature',referenceId:string(d.referenceId,128),resolvedAt:timestamp(d.resolvedAt),reason:d.reason as string}}
}
export function normalizeEvent(input: unknown) {
  switch(object(input).eventType) {
    case 'credit.lead.created':return normalizeCreatedEvent(input)
    case 'credit.lead.approved':return normalizeApprovedEvent(input)
    case 'credit.lead.documents.overdue':return normalizeDocumentsOverdueEvent(input)
    case 'credit.lead.signature.overdue':return normalizeSignatureOverdueEvent(input)
    case 'credit.lead.reminders.resolved':return normalizeResolvedEvent(input)
    default:throw invalid()
  }
}
export type CreditEvent = ReturnType<typeof normalizeEvent>
// Explicit schemas fix property order and normalize optional values before comparison.
export const canonicalEvent = (input: unknown) => JSON.stringify(normalizeEvent(input))
