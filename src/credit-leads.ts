import { Hono, type MiddlewareHandler } from 'hono'
import type { AppEnv } from './env'
import { authenticate, parseCredentials, type Credential } from './credit-auth'
import { connectCreditStore, type CreditStore } from './credit-store'
import { CreditError, invalid, normalizeEvent, origins, producer, string, timestamp } from './credit-schema'

type CreditEnv = {Bindings:AppEnv;Variables:{credential:Credential;store:CreditStore}}

export function createCreditRoutes(resolve: (env: AppEnv) => CreditStore = env => {
  if (!env.TURSO_DATABASE_URL) throw new Error('Missing TURSO_DATABASE_URL')
  return connectCreditStore(env.TURSO_DATABASE_URL,env.TURSO_AUTH_TOKEN)
}) {
  const routes = new Hono<CreditEnv>()
  const guard: MiddlewareHandler<CreditEnv> = async(c,next)=>{
    c.header('Cache-Control','no-store'); c.header('X-Content-Type-Options','nosniff')
    const started = Date.now()
    try {
      if (c.req.path === '/health/live') { await next(); return }
      const credentials = parseCredentials(c.env.API_CREDENTIALS_JSON)
      c.set('store',resolve(c.env))
      if (c.req.path !== '/health/ready') c.set('credential',await authenticate(c.req.raw.headers,credentials,c.req.method === 'POST' ? 'ingest' : 'read'))
      await next()
    } catch (error) {
      const e = error instanceof CreditError ? error : new CreditError(503,'Storage temporarily unavailable')
      if (e.status === 503) { c.header('Retry-After','10'); console.warn(JSON.stringify({result:'database_unavailable'})) }
      return c.json({detail:e.message},e.status)
    } finally { console.info(JSON.stringify({result:'credit_request',status:c.res.status,latencyMs:Date.now()-started})) }
  }
  for (const path of ['/webhooks/credit-leads','/api/credit-leads','/api/credit-leads/*','/health/live','/health/ready']) routes.use(path,guard)
  // Handle errors here so the parent's error handler cannot expose driver details.
  routes.onError((error,c)=>{
    const e = error instanceof CreditError ? error : new CreditError(503,'Storage temporarily unavailable')
    if (e.status === 503) { c.header('Retry-After','10'); console.warn(JSON.stringify({result:'database_unavailable'})) }
    return c.json({detail:e.message},e.status)
  })
  routes.get('/health/live',c=>c.json({ok:true}))
  routes.get('/health/ready',async c=>{await c.get('store').ready(); return c.json({ok:true})})
  routes.post('/webhooks/credit-leads',async c=>{
    const reader = c.req.raw.body?.getReader()
    if (!reader) throw invalid()
    const chunks: Uint8Array[] = []; let length = 0
    try {
      while (true) {
        const {done,value} = await reader.read(); if (done) break
        length += value.byteLength
        if (length > 65536) { await reader.cancel(); throw new CreditError(413,'Request body too large') }
        chunks.push(value)
      }
    } finally { reader.releaseLock() }
    const bytes = new Uint8Array(length); let offset = 0
    for (const chunk of chunks) { bytes.set(chunk,offset); offset += chunk.length }
    let raw: unknown
    try { raw = JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(bytes)) } catch { throw invalid() }
    const e = normalizeEvent(raw), credential = c.get('credential')
    if (!credential.producers.includes(e.producer) || !credential.origins.includes(e.data.origem)) throw new CreditError(403,'Forbidden')
    const duplicate = await c.get('store').ingest(e)
    console.info(JSON.stringify({result:duplicate ? 'event_duplicate':'event_stored',eventId:e.eventId,origem:e.data.origem}))
    return c.json({eventId:e.eventId,duplicate},duplicate ? 200:201)
  })
  const filters = (url: string, single = false) => {
    const params = new URL(url).searchParams, result: Record<string,string> = {}
    const allowed = single ? ['producer']:['page','page_size','origem','status','producer','lead_id','created_from','created_to']
    for (const [key,value] of params) {
      if (!allowed.includes(key) || params.getAll(key).length !== 1) throw invalid()
      result[key] = value
    }
    for (const [key,max] of [['page',1000000],['page_size',100]] as const) if (result[key] !== undefined && (!/^[0-9]+$/.test(result[key]) || Number(result[key]) < 1 || Number(result[key]) > max)) throw invalid()
    if (result.origem !== undefined && !origins.includes(result.origem)) throw invalid()
    if (result.status !== undefined && result.status !== 'PENDENTE') throw invalid()
    for (const [key,max] of [['producer',100],['lead_id',128]] as const) if (result[key] !== undefined) string(result[key],max)
    for (const key of ['created_from','created_to']) if (result[key] !== undefined) result[key] = timestamp(result[key])
    if (result.created_from && result.created_to && result.created_from > result.created_to) throw invalid()
    if (single && result.producer === undefined) result.producer = producer
    return result
  }
  routes.get('/api/credit-leads',async c=>c.json(await c.get('store').query(c.get('credential'),filters(c.req.url))))
  routes.get('/api/credit-leads/:leadId',async c=>c.json(await c.get('store').query(c.get('credential'),filters(c.req.url,true),string(c.req.param('leadId'),128))))
  return routes
}
