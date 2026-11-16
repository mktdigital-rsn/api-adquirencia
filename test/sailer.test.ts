import {afterEach,describe,expect,it,vi} from 'vitest'
import {createClient} from '@libsql/client'
import {readFileSync,readdirSync,mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createCreditStore} from '../src/credit-store'
import {normalizeEvent} from '../src/credit-schema'
import {sailerConfig,sailerPayload,sailerPhone} from '../src/sailer-contract'
import {createSailerDelivery} from '../src/sailer-delivery'
import app from '../src/index'
import {createCreditRoutes} from '../src/credit-leads'
import {createHash} from 'node:crypto'
import {spawnSync} from 'node:child_process'

const source=JSON.parse(readFileSync('examples/credit-lead.json','utf8'))
const cleanup:(()=>void)[]=[]
afterEach(()=>{cleanup.splice(0).forEach(fn=>fn());vi.restoreAllMocks()})
async function setup(phone:string|null='(71) 99999-9999') {
  const dir=mkdtempSync(join(tmpdir(),'sailer-')),url='file:'+join(dir,'test.db')
  const db=createClient({url}),other=createClient({url})
  cleanup.push(()=>{db.close();other.close();rmSync(dir,{recursive:true,force:true})})
  for(const file of readdirSync('migrations').sort())await db.executeMultiple(readFileSync(join('migrations',file),'utf8'))
  const store=createCreditStore(db,{sailerEnabled:true})
  const event=normalizeEvent({...source,data:{...source.data,phoneNumber:phone}})
  await store.ingest(event)
  let instant=Date.now()+1000
  const clock={now:()=>instant,advance:(ms:number)=>{instant+=ms}}
  const job=async()=>(await db.execute('SELECT * FROM sailer_deliveries')).rows[0]!
  const fetchImpl=vi.fn<typeof fetch>().mockResolvedValue(new Response(null,{status:200}))
  const options={url:'https://api.chatsailer.com/automations/hooks/test-only',token:'fake-unit-test-token',fetchImpl,now:clock.now,sleep:async(ms:number)=>{clock.advance(ms)}}
  const worker=createSailerDelivery(db,options)
  return {url,db,other,store,event,clock,job,fetchImpl,worker,options}
}
describe('Sailer outgoing contract',()=>{
  it.each([['(71) 99999-9999','71999999999'],['+55 (71) 99999-9999','5571999999999'],['7133334444','7133334444'],['71999999999','71999999999']])('normalizes phone %s without guessing a missing prefix',(input,expected)=>{expect(sailerPhone(input)).toBe(expected)})
  it.each([null,'','999999999','abc71999999999','(00) 99999-9999','123','71999999999 ext 4'])('blocks missing/incomplete phone %s',value=>{expect(sailerPhone(value)).toBeNull()})
  it('forwards exactly the client envelope and four fields, excluding birthDate and internal metadata',()=>{
    const event=normalizeEvent(source),payload=sailerPayload(event)!
    expect(payload).toEqual({eventId:event.eventId,eventType:'credit.lead.created',occurredAt:event.occurredAt,data:{name:event.data.name,taxNumber:event.data.taxNumber,email:event.data.email,phoneNumber:event.data.phoneNumber}})
    expect(Object.keys(payload.data).sort()).toEqual(['email','name','phoneNumber','taxNumber'])
  })
  it('validates configuration without printing credentials',()=>{
    expect(sailerConfig({})).toEqual({enabled:false})
    expect(()=>sailerConfig({SAILER_WEBHOOK_ENABLED:'true'})).toThrow()
    for(const url of ['http://api.chatsailer.com/automations/hooks/x','https://other.example/automations/hooks/x','https://api.chatsailer.com/automations/hooks/x#fragment'])expect(()=>sailerConfig({SAILER_WEBHOOK_ENABLED:'true',SAILER_WEBHOOK_URL:url,SAILER_WEBHOOK_TOKEN:'fake'})).toThrow()
    expect(sailerConfig({SAILER_WEBHOOK_ENABLED:'true',SAILER_WEBHOOK_URL:'https://api.chatsailer.com/automations/hooks/test-only',SAILER_WEBHOOK_TOKEN:'fake'})).toMatchObject({enabled:true})
  })
})
describe('Sailer persistent delivery with real libSQL',()=>{
  it('atomically queues once and sends the immutable minimal payload with X-API-Key',async()=>{
    const s=await setup();expect((await s.job()).status).toBe('pending')
    expect(await s.store.ingest(s.event)).toBe(true)
    expect((await s.db.execute('SELECT count(*) AS n FROM sailer_deliveries')).rows[0]!.n).toBe(1)
    await s.worker.drain();expect((await s.job()).status).toBe('delivered')
    const [url,request]=s.fetchImpl.mock.calls[0]!
    expect(url).toBe(s.options.url);expect(request!.headers).toEqual({'Content-Type':'application/json','X-API-Key':'fake-unit-test-token'})
    expect(request!.redirect).toBe('manual');expect(JSON.parse(String(request!.body))).toEqual(sailerPayload(s.event))
    await s.worker.drain();expect(s.fetchImpl).toHaveBeenCalledTimes(1)
  })
  it('rolls back event and lead if the delivery insertion fails',async()=>{
    const s=await setup();await s.db.execute("CREATE TRIGGER fail_sailer BEFORE INSERT ON sailer_deliveries BEGIN SELECT RAISE(ABORT,'failure'); END")
    const event=normalizeEvent({...source,eventId:crypto.randomUUID(),data:{...source.data,leadId:'new'}})
    await expect(s.store.ingest(event)).rejects.toThrow()
    expect((await s.db.execute('SELECT count(*) AS n FROM credit_events')).rows[0]!.n).toBe(1)
    expect((await s.db.execute('SELECT count(*) AS n FROM credit_leads')).rows[0]!.n).toBe(1)
  })
  it('preserves the lead but blocks delivery for missing phone',async()=>{
    const s=await setup(null);expect(await s.job()).toMatchObject({status:'blocked',last_error_code:'invalid_phone',attempts:0})
    expect((await s.db.execute('SELECT count(*) AS n FROM credit_leads')).rows[0]!.n).toBe(1)
    await s.worker.drain();expect(s.fetchImpl).not.toHaveBeenCalled()
  })
  it.each([401,403,422,302,400])('blocks HTTP %s without retries or leaking the response',async status=>{
    const s=await setup();s.fetchImpl.mockResolvedValue(new Response('do-not-store-personal-data',{status}))
    await s.worker.drain();expect(await s.job()).toMatchObject({status:'blocked',attempts:1,last_http_status:status,last_error_code:'http_'+status})
    s.clock.advance(86400000);await s.worker.drain();expect(s.fetchImpl).toHaveBeenCalledTimes(1)
  })
  it.each([408,429,500,503])('retries HTTP %s with the same event and body',async status=>{
    const s=await setup();s.fetchImpl.mockResolvedValueOnce(new Response(null,{status})).mockImplementation(()=>Promise.resolve(new Response(null,{status:200})))
    await s.worker.drain();expect((await s.job()).status).toBe('pending');expect((await s.job()).attempts).toBe(1)
    s.clock.advance(10001);await s.worker.drain();expect((await s.job()).status).toBe('delivered')
    expect(s.fetchImpl.mock.calls[0]![1]!.body).toBe(s.fetchImpl.mock.calls[1]![1]!.body)
  })
  it('respects Retry-After and persists failures across independent clients',async()=>{
    const s=await setup();s.fetchImpl.mockResolvedValueOnce(new Response(null,{status:429,headers:{'Retry-After':'60'}}))
    await s.worker.drain();s.clock.advance(10001)
    const restarted=createSailerDelivery(s.other,s.options);await restarted.drain();expect(s.fetchImpl).toHaveBeenCalledTimes(1)
    s.clock.advance(50000);await restarted.drain();expect((await s.job()).status).toBe('delivered')
  })
  it('retries network/timeout errors without acknowledging the outgoing delivery',async()=>{
    const s=await setup();s.fetchImpl.mockRejectedValueOnce(new Error('sensitive URL and headers'))
    await s.worker.drain();expect(await s.job()).toMatchObject({status:'pending',last_error_code:'network_error'})
    s.clock.advance(10001);await s.worker.drain();expect((await s.job()).status).toBe('delivered')
  })
  it('does not claim the same event concurrently on independent DB connections',async()=>{
    const s=await setup();s.fetchImpl.mockImplementation(()=>Promise.resolve(new Response(null,{status:200})))
    const results=await Promise.all([s.worker.drain(1),createSailerDelivery(s.other,s.options).drain(1)])
    expect(results.reduce((a,b)=>a+b,0)).toBe(1);expect(s.fetchImpl).toHaveBeenCalledTimes(1)
  })
  it('recovers expired leases and ignores stale completion tokens',async()=>{
    const s=await setup()
    await s.db.execute({sql:"UPDATE sailer_deliveries SET status='processing',attempts=1,first_attempt_ms=?,lease_until_ms=?,claim_token='abandoned'",args:[s.clock.now()-121000,s.clock.now()-1]})
    await s.worker.drain();expect(await s.job()).toMatchObject({status:'delivered',attempts:2,claim_token:null})
  })
  it('spaces dispatches through the global gate and caps each drain',async()=>{
    const s=await setup();s.fetchImpl.mockImplementation(()=>Promise.resolve(new Response(null,{status:200})))
    await s.store.ingest(normalizeEvent({...source,eventId:crypto.randomUUID(),data:{...source.data,leadId:'second'}}))
    const times:number[]=[];s.fetchImpl.mockImplementation(async()=>{times.push(s.clock.now());return new Response(null,{status:200})})
    expect(await s.worker.drain()).toBe(2);expect(times[1]!-times[0]!).toBeGreaterThanOrEqual(400)
  })
  it('stops before partner deduplication expires and after max attempts',async()=>{
    const s=await setup();await s.db.execute({sql:'UPDATE sailer_deliveries SET first_attempt_ms=?',args:[s.clock.now()-6*86400000]})
    await s.worker.drain();expect((await s.job()).status).toBe('failed');expect(s.fetchImpl).not.toHaveBeenCalled()
    await s.db.execute("UPDATE sailer_deliveries SET status='pending',attempts=10,first_attempt_ms=NULL")
    await s.worker.drain();expect((await s.job()).status).toBe('failed')
  })
  it('commits receipt before sending and acknowledges receipt despite partner failure',async()=>{
    const s=await setup()
    const auth={client_id:'test-ingest',key_sha256:[createHash('sha256').update('fake-secret').digest('hex')],scopes:['ingest'],producers:['bankwhitelabel-server'],origins:['PUBLICA']}
    const event=normalizeEvent({...source,eventId:crypto.randomUUID(),data:{...source.data,leadId:'second'}})
    const verify=vi.fn(async()=>{
      const rows=await s.other.execute({sql:'SELECT id FROM credit_events WHERE event_id=?',args:[event.eventId]})
      expect(rows.rows).toHaveLength(1)
      throw new Error('partner unavailable')
    })
    const routes=createCreditRoutes(()=>s.store,verify)
    const response=await routes.request('http://localhost/webhooks/credit-leads',{method:'POST',headers:{'X-Client-Id':'test-ingest','X-API-Key':'fake-secret'},body:JSON.stringify(event)},
      {API_CREDENTIALS_JSON:JSON.stringify([auth]),SAILER_WEBHOOK_ENABLED:'true',SAILER_WEBHOOK_URL:s.options.url,SAILER_WEBHOOK_TOKEN:'fake-unit-test-token'})
    expect(response.status).toBe(201);expect(verify).toHaveBeenCalledTimes(1)
    expect((await s.db.execute('SELECT count(*) AS n FROM sailer_deliveries')).rows[0]!.n).toBe(2)
  })
  it('rolls back the outbox on commit failure and never attempts HTTP before commit',async()=>{
    const s=await setup(),original=s.db.transaction.bind(s.db)
    vi.spyOn(s.db,'transaction').mockImplementation(async()=>{const tx=await original();vi.spyOn(tx,'commit').mockRejectedValue(new Error('failure'));return tx})
    await expect(s.store.ingest(normalizeEvent({...source,eventId:crypto.randomUUID(),data:{...source.data,leadId:'commit-fails'}}))).rejects.toThrow()
    for(const table of ['credit_events','credit_leads','sailer_deliveries'])expect((await s.db.execute('SELECT count(*) AS n FROM '+table)).rows[0]!.n).toBe(1)
    expect(s.fetchImpl).not.toHaveBeenCalled()
  })
  it('pauses the global gate after 429, including for unrelated pending leads',async()=>{
    const s=await setup();await s.store.ingest(normalizeEvent({...source,eventId:crypto.randomUUID(),data:{...source.data,leadId:'second'}}))
    s.fetchImpl.mockResolvedValueOnce(new Response(null,{status:429,headers:{'Retry-After':'60'}}))
    expect(await s.worker.drain()).toBe(1)
    s.clock.advance(10000);await createSailerDelivery(s.other,s.options).drain();expect(s.fetchImpl).toHaveBeenCalledTimes(1)
  })
  it('operational status and retry commands preserve payload and refuse delivered or expired jobs',async()=>{
    const s=await setup();await s.db.execute("UPDATE sailer_deliveries SET status='blocked',last_error_code='http_401'")
    const env={...process.env,TURSO_DATABASE_URL:s.url,SAILER_WEBHOOK_ENABLED:'false'}
    const before=(await s.job()).payload
    const result=spawnSync(process.execPath,['scripts/sailer-retry.js',s.event.eventId],{env,encoding:'utf8'})
    expect(result.status).toBe(0);expect(result.stdout).toContain('\"requeued\":1');expect((await s.job()).payload).toBe(before)
    await s.worker.drain()
    const again=spawnSync(process.execPath,['scripts/sailer-retry.js',s.event.eventId],{env,encoding:'utf8'})
    expect(again.stdout).toContain('\"requeued\":0')
    const status=spawnSync(process.execPath,['scripts/sailer-status.js'],{env,encoding:'utf8'})
    expect(status.status).toBe(0);expect(status.stdout).not.toContain(source.data.email);expect(status.stdout).not.toContain('fake-unit-test-token')
  })
  it('leaves old events unqueued and remains disabled without configuration',async()=>{
    const s=await setup(),event=normalizeEvent({...source,eventId:crypto.randomUUID(),data:{...source.data,leadId:'disabled'}})
    const disabled=createCreditStore(s.db);await disabled.ingest(event)
    expect((await s.db.execute('SELECT count(*) AS n FROM sailer_deliveries')).rows[0]!.n).toBe(1)
  })
  it('exports the real scheduled handler even with the old webhook poll disabled',async()=>{
    const waitUntil=vi.fn();await app.scheduled({} as ScheduledEvent,{WEBHOOK_POLL_ENABLED:'false'},{waitUntil} as unknown as ExecutionContext)
    expect(waitUntil).toHaveBeenCalledTimes(1)
    await waitUntil.mock.calls[0]![0]
  })
})
