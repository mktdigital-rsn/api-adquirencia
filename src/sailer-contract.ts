import type { AppEnv } from './env'
import type { CreditEvent } from './credit-schema'

export function sailerConfig(env: AppEnv) {
  if (env.SAILER_WEBHOOK_ENABLED !== undefined && !['true','false'].includes(env.SAILER_WEBHOOK_ENABLED)) throw new Error('Invalid Sailer enable flag')
  const enabled = env.SAILER_WEBHOOK_ENABLED === 'true'
  if (!enabled) return {enabled:false as const}
  let url: URL
  try { url = new URL(env.SAILER_WEBHOOK_URL ?? '') } catch { throw new Error('Invalid Sailer URL configuration') }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port || url.hostname !== 'api.chatsailer.com' || !url.pathname.startsWith('/automations/hooks/')) throw new Error('Invalid Sailer URL configuration')
  const token = env.SAILER_WEBHOOK_TOKEN
  if (!token || !/^[\x21-\x7e]+$/.test(token)) throw new Error('Invalid Sailer token configuration')
  return {enabled:true as const,url:url.toString(),token}
}

// Current Sailer contract requires DDD. Preserve a supplied Brazilian DDI;
// never guess a missing DDD, country, or subscriber number.
export function sailerPhone(value: string | null): string | null {
  if (!value || !/^\+?[\d\s().-]+$/.test(value.trim())) return null
  const digits = value.replace(/\D/g,'')
  const national = (digits.length === 12 || digits.length === 13) && digits.startsWith('55') ? digits.slice(2) : digits
  if (!/^[1-9]\d\d{8,9}$/.test(national)) return null
  return digits
}
export function sailerPayload(event: CreditEvent, storedPhone?:string|null) {
  if(event.eventType==='credit.lead.reminders.resolved')return null
  const phoneNumber = sailerPhone(event.data.phoneNumber ?? storedPhone ?? null)
  if (!phoneNumber) return null
  return {
    eventId:event.eventId,
    eventType:event.eventType,
    occurredAt:event.occurredAt,
    data:{name:event.data.name,taxNumber:event.data.taxNumber,email:event.data.email,phoneNumber},
  }
}
