import { afterEach, describe, expect, it, vi } from 'vitest'
import { createClient, type Client } from '@libsql/client'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import mainApp from '../src/index'
import { createCreditRoutes } from '../src/credit-leads'
import { createCreditStore } from '../src/credit-store'
import { normalizeEvent, canonicalEvent } from '../src/credit-schema'
import { parseCredentials } from '../src/credit-auth'
const sample = JSON.parse(readFileSync('examples/credit-lead.json','utf8'))
const hash = (key: string) => createHash('sha256').update(key).digest('hex')
const entry = {client_id:'test',key_sha256:[hash('secret'),hash('new')],scopes:['ingest','read'],producers:['bankwhitelabel-server'],origins:['PUBLICA','AGENTE','IB']}
const headers = {'x-client-id':'test','x-api-key':'secret'}
const cleanup: (()=>void)[] = []
afterEach(()=>{ for (const fn of cleanup.splice(0)) fn(); vi.restoreAllMocks() })
async function setup(config = [entry]) {
  const dir = mkdtempSync(join(tmpdir(),'credit-test-')), url = `file:${dir}/test.db`
  const db = createClient({url}), other = createClient({url})
  cleanup.push(()=>{db.close();other.close();rmSync(dir,{recursive:true,force:true})})
  await db.executeMultiple(readFileSync('migrations/0001_credit_leads.sql','utf8'))
  const store = createCreditStore(db), app = createCreditRoutes(()=>store), env = {API_CREDENTIALS_JSON:JSON.stringify(config)}
  const request = (path = '/webhooks/credit-leads', body: unknown = sample, auth: Record<string,string> = headers) => app.request(`http://localhost${path}`,{method:path.startsWith('/webhooks')?'POST':'GET',headers:auth,...(path.startsWith('/webhooks')?{body:JSON.stringify(body)}:{})},env)
  const count = async(table: string)=>Number((await db.execute(`SELECT count(*) AS n FROM ${table}`)).rows[0]!.n)
  return {db,other,store,app,env,request,count}
}
describe('credit receiver with real libSQL',()=>{
  it('mounts the exact routes without affecting existing health or unknown routes',async()=>{
    const env={API_CREDENTIALS_JSON:JSON.stringify([entry]),TURSO_DATABASE_URL:'https://unused.invalid'}
    const r=await mainApp.request('http://localhost/webhooks/credit-leads',{method:'POST',body:'{}'},env)
    expect(r.status).toBe(401);expect(r.headers.get('x-content-type-options')).toBe('nosniff')
    expect((await mainApp.request('http://localhost/health')).status).toBe(200)
    expect((await mainApp.request('http://localhost/unknown')).status).toBe(404)
  })
  it.each(['PUBLICA','AGENTE','IB'])('stores %s and preserves decimal',async origem=>{
    const s = await setup(); const e = structuredClone(sample); e.data.origem = origem
    expect((await s.request(undefined,e)).status).toBe(201)
    expect(await s.count('credit_events')).toBe(1); expect(await s.count('credit_leads')).toBe(1)
    expect(await (await s.request('/api/credit-leads/123')).json()).toMatchObject({amount:'5000.00',origem})
    expect((await s.request(undefined,e)).status).toBe(200)
    e.data.amount = '6000'; expect((await s.request(undefined,e)).status).toBe(409)
    e.eventId = crypto.randomUUID(); expect((await s.request(undefined,e)).status).toBe(409)
    expect(await s.count('credit_events')).toBe(1)
  })
  it('concurrent independent connections and application restart deduplicate',async()=>{
    const s = await setup(), other = createCreditRoutes(()=>createCreditStore(s.other))
    const results = await Promise.all([s.request(),other.request('http://localhost/webhooks/credit-leads',{method:'POST',headers,body:JSON.stringify(sample)},s.env)])
    expect(results.map(r=>r.status).sort()).toEqual([200,201])
    expect(await s.count('credit_events')).toBe(1); expect(await s.count('credit_leads')).toBe(1)
    expect(await createCreditStore(s.other).ingest(normalizeEvent(sample))).toBe(true)
  })
  it('restricts rows, count and individual reads by origin',async()=>{
    const s = await setup(); await s.request()
    const e = structuredClone(sample); e.eventId = crypto.randomUUID(); e.data.leadId='ib';e.data.origem='IB';await s.request(undefined,e)
    s.env.API_CREDENTIALS_JSON = JSON.stringify([{...entry,origins:['PUBLICA']}])
    expect(await (await s.request('/api/credit-leads')).json()).toMatchObject({total:1})
    expect((await s.request('/api/credit-leads/ib')).status).toBe(404)
    expect((await s.request(undefined,e)).status).toBe(403)
  })
  it('enforces scopes, rotation, revocation and ambiguous headers',async()=>{
    const s = await setup([{...entry,scopes:['ingest']}])
    expect((await s.request('/api/credit-leads')).status).toBe(403)
    expect((await s.request(undefined,sample,{'x-client-id':'test','x-api-key':'new'})).status).toBe(201)
    s.env.API_CREDENTIALS_JSON=JSON.stringify([{...entry,key_sha256:[hash('new')]}])
    for (const auth of [{},{...headers,'x-api-key':'wrong'},{...headers,'x-client-id':'test, test'},headers]) expect((await s.request(undefined,sample,auth)).status).toBe(401)
  })
  it.each([
    {schemaVersion:true},{schemaVersion:'1'},{schemaVersion:2},{eventId:'bad'},{producer:'bad'},{eventType:'bad'},{extra:1},{occurredAt:'2026-11-09T15:00:00'},
    ...[{amount:5000},{amount:'0.00'},{amount:'-1'},{amount:'1e2'},{userId:true},{userId:9007199254740992},{agentId:1},{status:'DONE'},{extra:1},{createdAt:'2026-02-30T15:00:00Z'}].map(d=>({data:{...sample.data,...d}}))
  ])('rejects invalid contract %j without storage',async change=>{
    const s=await setup();const response=await s.request(undefined,{...sample,...change})
    expect(response.status).toBe(422); expect(await response.json()).toEqual({detail:'Invalid request contract or parameters'});expect(await s.count('credit_events')).toBe(0)
  })
  it('accepts Java nanosecond timestamps without truncation and filters by exact instant',async()=>{
    const s=await setup(), e=structuredClone(sample)
    e.occurredAt='2026-11-09T15:00:00.123456789Z'
    e.data.createdAt='2026-11-09T12:00:00.987654321-03:00'
    expect((await s.request(undefined,e)).status).toBe(201)
    expect((await s.request(undefined,e)).status).toBe(200)
    const stored=JSON.parse(String((await s.db.execute('SELECT payload FROM credit_events')).rows[0]!.payload))
    expect(stored.occurredAt).toBe(e.occurredAt)
    expect(stored.data.createdAt).toBe('2026-11-09T15:00:00.987654321Z')
    const query='/api/credit-leads?created_from=2026-11-09T15:00:00.987654321Z&created_to=2026-11-09T15:00:00.987654321Z'
    expect(await (await s.request(query)).json()).toMatchObject({total:1})
    expect(await (await s.request('/api/credit-leads?created_from=2026-11-09T15:00:00.987654322Z')).json()).toMatchObject({total:0})
    const offset=structuredClone(e);offset.occurredAt='2026-11-09T12:00:00.123456789-03:00'
    expect(canonicalEvent(offset)).toBe(canonicalEvent(e))
  })
  it('migrates existing microsecond dates without changing snapshots or deduplication',async()=>{
    const s=await setup();await s.request()
    await s.db.execute("UPDATE credit_leads SET created_at='2026-11-09T15:00:00.000000Z'")
    const sql=readFileSync('migrations/0002_credit_timestamp_precision.sql','utf8')
    await s.db.executeMultiple(sql);await s.db.executeMultiple(sql)
    expect((await s.db.execute('SELECT created_at FROM credit_leads')).rows[0]!.created_at).toBe('2026-11-09T15:00:00.000000000Z')
    expect(await (await s.request('/api/credit-leads?created_to=2026-11-09T15:00:00Z')).json()).toMatchObject({total:1})
    expect((await s.request()).status).toBe(200)
  })
  it('normalizes property order, UUID, timezone and missing nulls',()=>{
    const e = structuredClone(sample);e.eventId=e.eventId.toUpperCase();e.occurredAt='2026-11-09T12:00:00-03:00';delete e.data.userId
    expect(canonicalEvent(e)).toBe(canonicalEvent(sample))
  })
  it('rolls back on lead insertion failure then accepts retry',async()=>{
    const s = await setup()
    await s.db.execute("CREATE TRIGGER fail_lead BEFORE INSERT ON credit_leads BEGIN SELECT RAISE(ABORT,'failure'); END")
    const r=await s.request();expect(r.status).toBe(503);expect(r.headers.get('retry-after')).toBe('10');expect(await s.count('credit_events')).toBe(0)
    await s.db.execute('DROP TRIGGER fail_lead');expect((await s.request()).status).toBe(201)
  })
  it('returns 503 on failed commit and rolls back both rows',async()=>{
    const s = await setup(), original=s.db.transaction.bind(s.db)
    vi.spyOn(s.db,'transaction').mockImplementation(async ()=>{
      const tx=await original();vi.spyOn(tx,'commit').mockRejectedValue(new Error('commit failure'));return tx
    })
    expect((await s.request()).status).toBe(503);expect(await s.count('credit_events')).toBe(0);expect(await s.count('credit_leads')).toBe(0)
  })
  it('checks pagination, filters, timezone interval and no-store',async()=>{
    const s=await setup();await s.request()
    const r=await s.request('/api/credit-leads?page_size=1&created_from=2026-11-09T12:00:00-03:00&created_to=2026-11-09T15:00:00Z');expect(r.status).toBe(200);expect(await r.json()).toMatchObject({total:1,pageSize:1});expect(r.headers.get('cache-control')).toBe('no-store');expect(r.headers.get('x-content-type-options')).toBe('nosniff')
    for(const query of ['page=0','page_size=101','page=1.5','created_from=2027-01-01T00:00:00Z&created_to=2026-01-01T00:00:00Z','origem=OTHER']) expect((await s.request('/api/credit-leads?'+query)).status).toBe(422)
  })
  it('rejects malformed JSON and oversized streamed bodies',async()=>{
    const s=await setup()
    expect((await s.app.request('http://localhost/webhooks/credit-leads',{method:'POST',headers,body:'{'},s.env)).status).toBe(422)
    const stream=new ReadableStream({start(c){c.enqueue(new Uint8Array(40000));c.enqueue(new Uint8Array(30000));c.close()}})
    const r=await s.app.request('http://localhost/webhooks/credit-leads',{method:'POST',headers,body:stream,duplex:'half'} as RequestInit,s.env)
    expect(r.status).toBe(413)
    expect((await s.request(undefined,'x'.repeat(66000))).status).toBe(413)
  })
  it('migration is repeatable and health checks verify storage',async()=>{
    const s=await setup();await s.db.executeMultiple(readFileSync('migrations/0001_credit_leads.sql','utf8'))
    expect((await s.request('/health/ready')).status).toBe(200)
    await s.db.execute('DROP TABLE credit_leads');await s.db.execute('DROP TABLE credit_events')
    expect((await s.request('/health/ready')).status).toBe(503)
    expect((await s.request('/health/live')).status).toBe(200)
  })
  it.each([undefined,'[]','{}','bad',JSON.stringify([{...entry,scopes:['admin']}]),JSON.stringify([entry,entry])])('rejects invalid configuration',raw=>{expect(()=>parseCredentials(raw)).toThrow('configuration')})
})
