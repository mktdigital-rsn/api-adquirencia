import {afterEach,describe,expect,it,vi} from 'vitest'
import {createClient} from '@libsql/client'
import {readFileSync,readdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createHash} from 'node:crypto'
import {createCreditStore} from '../src/credit-store'
import {createCreditRoutes} from '../src/credit-leads'
import {createSailerDelivery} from '../src/sailer-delivery'
import {normalizeEvent} from '../src/credit-schema'

const source=JSON.parse(readFileSync('examples/credit-lead.json','utf8'))
const now=Date.now(),start=now-49*3600000
const iso=(time:number)=>new Date(time).toISOString()
const contact={leadId:'123',origem:'PUBLICA',name:'Pessoa de teste',email:'teste@example.com',taxNumber:'00000000000',phoneNumber:'71999999999'}
function approval(){return {eventId:crypto.randomUUID(),eventType:'credit.lead.approved',schemaVersion:1,producer:'bankwhitelabel-server',occurredAt:iso(now),data:{...contact,status:'AGUARDANDO_DOCUMENTACAO_KYC'}}}
function reminder(kind:'documents'|'signature',number=1,referenceId='cycle-7') {
 const hours=kind==='documents'?(number===1?0:48):(number===1?24:48)
 return {...approval(),eventType:`credit.lead.${kind}.overdue`,data:{...contact,status:kind==='documents'?'AGUARDANDO_DOCUMENTACAO_KYC':'CCB_ENVIADA',
  ...(kind==='documents'?{collectionLinkId:referenceId,expiresAt:iso(now+7*86400000)}:{ccbId:referenceId}),
  requestedAt:iso(start),dueAt:iso(start+hours*3600000),thresholdHours:hours,reminderNumber:number,message:'Lembrete sintético'}}
}
function resolved(kind:'documents'|'signature',referenceId='cycle-7') {
 return {...approval(),eventType:'credit.lead.reminders.resolved',data:{...contact,kind,referenceId,resolvedAt:iso(now),reason:kind==='documents'?'received':'signed'}}
}
const cleanup:(()=>void)[]=[]
afterEach(()=>{cleanup.splice(0).forEach(fn=>fn());vi.restoreAllMocks()})
async function setup() {
 const directory=mkdtempSync(join(tmpdir(),'credit-lifecycle-')),url='file:'+join(directory,'test.db')
 const db=createClient({url}),other=createClient({url})
 cleanup.push(()=>{db.close();other.close();rmSync(directory,{recursive:true,force:true})})
 for(const f of readdirSync('migrations').sort())await db.executeMultiple(readFileSync(join('migrations',f),'utf8'))
 const store=createCreditStore(db,{sailerEnabled:true}),deliver=vi.fn().mockResolvedValue(undefined)
 const app=createCreditRoutes(()=>store,deliver)
 const cred={client_id:'test',key_sha256:[createHash('sha256').update('test-secret').digest('hex')],scopes:['ingest','read'],producers:['bankwhitelabel-server'],origins:['PUBLICA','IB','AGENTE']}
 const env={API_CREDENTIALS_JSON:JSON.stringify([cred]),SAILER_WEBHOOK_ENABLED:'true',SAILER_WEBHOOK_URL:'https://api.chatsailer.com/automations/hooks/test-only',SAILER_WEBHOOK_TOKEN:'test-only-token'}
 const headers={'X-Client-Id':'test','X-API-Key':'test-secret'}
 const request=(body:unknown)=>app.request('http://localhost/webhooks/credit-leads',{method:'POST',headers,body:JSON.stringify(body)},env)
 const jobs=async()=>(await db.execute('SELECT e.event_id,e.payload AS incoming,d.* FROM sailer_deliveries d JOIN credit_events e ON e.id=d.event_pk ORDER BY d.id')).rows
 const count=async(table:string)=>Number((await db.execute('SELECT count(*) AS n FROM '+table)).rows[0]!.n)
 const fetchImpl=vi.fn<typeof fetch>().mockImplementation(()=>Promise.resolve(new Response(null,{status:200})))
 let instant=now+1000
 const options={url:env.SAILER_WEBHOOK_URL,token:env.SAILER_WEBHOOK_TOKEN,fetchImpl,now:()=>instant,sleep:async(ms:number)=>{instant+=ms}}
 const worker=createSailerDelivery(db,options)
 return {db,other,url,store,app,env,headers,request,jobs,count,fetchImpl,options,worker}
}
describe('credit lifecycle and Sailer forwarding',()=>{
 it('proves creation, approval, two document and two signature reminders, with immutable retries',async()=>{
  const s=await setup(),events=[source,approval(),reminder('documents',1),reminder('documents',2),reminder('signature',1),reminder('signature',2)]
  const receipts=[]
  for(const e of events){const response=await s.request(e);expect(response.status).toBe(201);receipts.push(await response.json());expect((await s.request(e)).status).toBe(200)}
  expect(await s.count('credit_leads')).toBe(1);expect(await s.count('credit_events')).toBe(6);expect(await s.count('sailer_deliveries')).toBe(6)
  await s.worker.drain();expect(s.fetchImpl).toHaveBeenCalledTimes(6)
  const outgoing=s.fetchImpl.mock.calls.map(call=>({url:call[0],headers:call[1]!.headers,body:JSON.parse(String(call[1]!.body))}))
  expect(outgoing.map(x=>x.body.eventType)).toEqual(events.map(e=>e.eventType))
  for(const entry of outgoing){expect(entry.url).toBe(s.env.SAILER_WEBHOOK_URL);expect(entry.headers).toEqual({'Content-Type':'application/json','X-API-Key':'test-only-token'});expect(Object.keys(entry.body.data).sort()).toEqual(['email','name','phoneNumber','taxNumber']);expect(entry.body.data.phoneNumber).toBeTruthy()}
  const statuses=(await s.jobs()).map(row=>row.status);expect(statuses).toEqual(Array(6).fill('delivered'))
  if(process.env.CREDIT_EVIDENCE_FILE)writeFileSync(process.env.CREDIT_EVIDENCE_FILE,JSON.stringify({executedAt:iso(Date.now()),mode:'Hono real routes + real local libSQL; Sailer HTTP simulated, no external requests',receipts,outgoing:outgoing.map(({body})=>body),statuses,counts:{events:await s.count('credit_events'),leads:await s.count('credit_leads'),deliveries:await s.count('sailer_deliveries')}},null,2))
 })
 it.each(['documents','signature'] as const)('cancels pending and late %s reminders and never forwards the internal resolution',async kind=>{
  const s=await setup();const first=reminder(kind,1),second=reminder(kind,2)
  await s.request(first);expect((await s.request(resolved(kind))).status).toBe(201)
  expect((await s.request(second)).status).toBe(201)
  expect((await s.jobs()).map(row=>[row.status,row.last_error_code])).toEqual([['blocked','reminder_resolved'],['blocked','reminder_resolved']])
  expect(await s.count('credit_events')).toBe(3);expect(await s.count('sailer_deliveries')).toBe(2)
  await s.worker.drain();expect(s.fetchImpl).not.toHaveBeenCalled()
  // Independent connection / process recovers the same durable resolution.
  await createSailerDelivery(s.other,s.options).drain();expect(s.fetchImpl).not.toHaveBeenCalled()
 })
 it('cancels claimed/retry jobs, preserves delivered history, and leaves a new cycle active',async()=>{
  const s=await setup();await s.request(reminder('documents',1));await s.worker.drain()
  await s.request(reminder('documents',2));await s.db.execute("UPDATE sailer_deliveries SET status='processing',claim_token='dead-worker',lease_until_ms=0 WHERE status='pending'")
  await s.request(resolved('documents'));await s.request(reminder('documents',1,'new-cycle'))
  const rows=await s.jobs();expect(rows.map(row=>row.status)).toEqual(['delivered','blocked','pending'])
  await s.worker.drain();expect(s.fetchImpl).toHaveBeenCalledTimes(2)
 })
 it('cancels with forwarding paused and refuses to resurrect a resolved job on operational retry',async()=>{
  const s=await setup();await s.request(reminder('signature',1))
  await createCreditStore(s.other,{sailerEnabled:false}).ingest(normalizeEvent(resolved('signature')))
  expect((await s.jobs())[0]!.last_error_code).toBe('reminder_resolved')
  const {spawnSync}=await import('node:child_process')
  const result=spawnSync(process.execPath,['scripts/sailer-retry.js',String((await s.jobs())[0]!.event_id)],{env:{...process.env,TURSO_DATABASE_URL:s.url},encoding:'utf8'})
  expect(result.status).toBe(0);expect(result.stdout).toContain('"requeued":0')
 })
 it('supports modern events before creation using their own phone, without inventing a lead',async()=>{
  const s=await setup();expect((await s.request(approval())).status).toBe(201)
  await s.worker.drain();expect(s.fetchImpl).toHaveBeenCalledTimes(1);expect(await s.count('credit_leads')).toBe(0)
 })
 it('keeps snapshot and list counts unchanged by lifecycle events',async()=>{
  const s=await setup();await s.request(source)
  const before=await s.db.execute('SELECT data FROM credit_leads')
  await s.request(approval());await s.request(reminder('documents'))
  expect((await s.db.execute('SELECT data FROM credit_leads')).rows).toEqual(before.rows)
  const list=await s.app.request('http://localhost/api/credit-leads',{headers:s.headers},s.env)
  expect(await list.json()).toMatchObject({total:1})
 })
 it('rejects a third reminder, conflicting ordinal identity, and changed duplicate content',async()=>{
  const s=await setup(),first=reminder('documents')
  expect((await s.request(first)).status).toBe(201)
  expect((await s.request({...first,eventId:crypto.randomUUID()})).status).toBe(409)
  expect((await s.request({...first,data:{...first.data,message:'changed'}})).status).toBe(409)
  expect((await s.request(reminder('documents',3))).status).toBe(422)
  expect(await s.count('credit_events')).toBe(1)
 })
 it.each([approval(),reminder('documents'),reminder('signature'),resolved('documents')])('deduplicates %s between independent writers',async raw=>{
  const s=await setup(),e=normalizeEvent(raw),other=createCreditStore(s.other,{sailerEnabled:true})
  expect((await Promise.all([s.store.ingest(e),other.ingest(e)])).sort()).toEqual([false,true])
  expect(await s.count('credit_events')).toBe(1)
 })
 it('rolls back lifecycle + event if outgoing queue insertion fails',async()=>{
  const s=await setup();await s.db.execute("CREATE TRIGGER fail_job BEFORE INSERT ON sailer_deliveries BEGIN SELECT RAISE(ABORT,'failure'); END")
  expect((await s.request(approval())).status).toBe(503)
  expect(await s.count('credit_events')).toBe(0);expect(await s.count('credit_lifecycle_events')).toBe(0)
 })
 it('does not send expired modern document reminders',async()=>{
  const s=await setup(),raw=reminder('documents')
  Object.assign(raw.data,{expiresAt:iso(now-1)})
  expect((await s.request(raw)).status).toBe(201)
  expect((await s.jobs())[0]!.last_error_code).toBe('reminder_expired')
  await s.worker.drain();expect(s.fetchImpl).not.toHaveBeenCalled()
 })
 it('enforces origin scope and refuses mismatches with the stored lead',async()=>{
  const s=await setup();await s.request(source)
  const e=approval();e.data.origem='IB'
  expect((await s.request(e)).status).toBe(403)
 })
 it.each([null,'','   ',123])('requires nonblank phone for new lifecycle events: %s',async phoneNumber=>{
  const s=await setup(),e=approval()
  expect((await s.request({...e,data:{...e.data,phoneNumber}})).status).toBe(422)
 })
 it('enforces explicit timing and 48h document interval, without calculating business state locally',async()=>{
  const s=await setup(),e=reminder('documents',2)
  for(const changes of [{thresholdHours:24},{thresholdHours:48,dueAt:iso(start+24*3600000)},{reminderNumber:true},{dueAt:'2026-11-25T12:00:00'}])expect((await s.request({...e,data:{...e.data,...changes}})).status).toBe(422)
 })
 it('retries Sailer failures with exactly the same UUID and immutable body',async()=>{
  const s=await setup();await s.request(approval())
  s.fetchImpl.mockImplementationOnce(()=>Promise.resolve(new Response(null,{status:500})))
  await s.worker.drain();const first=s.fetchImpl.mock.calls[0]![1]!.body
  await s.db.execute("UPDATE sailer_deliveries SET next_attempt_ms=0")
  await s.worker.drain();expect(s.fetchImpl.mock.calls[1]![1]!.body).toBe(first)
 })
 it('migrates old alert identities without deleting history, and migration can run again',async()=>{
  const s=await setup(),legacy=JSON.parse(readFileSync('examples/credit-documents-overdue.json','utf8'))
  await s.db.execute({sql:'INSERT INTO credit_events(producer,event_id,payload,received_at) VALUES(?,?,?,?)',args:[legacy.producer,legacy.eventId,JSON.stringify(legacy),iso(now)]})
  await s.db.execute("INSERT INTO credit_document_alerts(event_pk,producer,lead_id,collection_link_id) SELECT id,producer,'123','7' FROM credit_events")
  const sql=readFileSync('migrations/0005_credit_lifecycle.sql','utf8');await s.db.executeMultiple(sql);await s.db.executeMultiple(sql)
  expect(await s.count('credit_lifecycle_events')).toBe(1);expect(await s.count('credit_document_alerts')).toBe(1)
  expect(await s.store.ingest(normalizeEvent(legacy))).toBe(true)
 })
})
