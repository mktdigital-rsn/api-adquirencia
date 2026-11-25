import {afterEach,describe,it,expect,vi} from 'vitest'
import {createClient} from '@libsql/client'
import {readFileSync,readdirSync,mkdtempSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createHash} from 'node:crypto'
import {normalizeEvent,normalizeCreatedEvent,normalizeDocumentsOverdueEvent} from '../src/credit-schema'
import {createCreditStore} from '../src/credit-store'
import {createCreditRoutes} from '../src/credit-leads'
import {createSailerDelivery} from '../src/sailer-delivery'

const creation=JSON.parse(readFileSync('examples/credit-lead.json','utf8'))
const overdue=JSON.parse(readFileSync('examples/credit-documents-overdue.json','utf8'))
const cleanup:(()=>void)[]=[]
afterEach(()=>{cleanup.splice(0).forEach(fn=>fn());vi.restoreAllMocks()})
async function setup(origins=['PUBLICA','IB','AGENTE']){
 const directory=mkdtempSync(join(tmpdir(),'overdue-')),url='file:'+join(directory,'test.db')
 const db=createClient({url}),other=createClient({url})
 cleanup.push(()=>{db.close();other.close();rmSync(directory,{recursive:true,force:true})})
 for(const file of readdirSync('migrations').sort())await db.executeMultiple(readFileSync(join('migrations',file),'utf8'))
 const store=createCreditStore(db,{sailerEnabled:true}),deliver=vi.fn().mockResolvedValue(undefined)
 const app=createCreditRoutes(()=>store,deliver)
 const credential={client_id:'producer-test',key_sha256:[createHash('sha256').update('secret').digest('hex')],scopes:['ingest','read'],producers:['bankwhitelabel-server'],origins}
 const env={API_CREDENTIALS_JSON:JSON.stringify([credential]),SAILER_WEBHOOK_ENABLED:'true',SAILER_WEBHOOK_URL:'https://api.chatsailer.com/automations/hooks/test-only',SAILER_WEBHOOK_TOKEN:'fake-test-token'}
 const headers={'X-Client-Id':'producer-test','X-API-Key':'secret'}
 const request=(body:unknown)=>app.request('http://localhost/webhooks/credit-leads',{method:'POST',headers,body:JSON.stringify(body)},env)
 const count=async(table:string)=>Number((await db.execute('SELECT count(*) AS n FROM '+table)).rows[0]!.n)
 return {db,other,store,app,env,headers,credential,request,count,deliver}
}
describe('credit.lead.documents.overdue',()=>{
 it('stores and forwards an overdue alert without inserting or changing a lead',async()=>{
  const s=await setup();expect((await s.request(creation)).status).toBe(201)
  const before=String((await s.db.execute('SELECT data FROM credit_leads')).rows[0]!.data)
  expect((await s.request(overdue)).status).toBe(201)
  expect(await s.count('credit_events')).toBe(2);expect(await s.count('credit_leads')).toBe(1);expect(await s.count('credit_lifecycle_events')).toBe(1)
  expect(String((await s.db.execute('SELECT data FROM credit_leads')).rows[0]!.data)).toBe(before)
  const row=(await s.db.execute({sql:'SELECT d.payload FROM sailer_deliveries d JOIN credit_events e ON e.id=d.event_pk WHERE e.event_id=?',args:[overdue.eventId]})).rows[0]!
  const payload=JSON.parse(String(row.payload))
  expect(payload).toEqual({eventId:overdue.eventId,eventType:overdue.eventType,occurredAt:'2026-11-17T15:01:00.000000000Z',data:{name:overdue.data.name,email:overdue.data.email,taxNumber:overdue.data.taxNumber,phoneNumber:creation.data.phoneNumber}})
  expect(Object.keys(payload.data).sort()).toEqual(['email','name','phoneNumber','taxNumber'])
  const fetchImpl=vi.fn<typeof fetch>().mockImplementation(()=>Promise.resolve(new Response(null,{status:200})))
  const worker=createSailerDelivery(s.db,{url:s.env.SAILER_WEBHOOK_URL,token:s.env.SAILER_WEBHOOK_TOKEN,fetchImpl})
  await worker.drain()
  expect(fetchImpl.mock.calls.map(call=>JSON.parse(String(call[1]!.body)).eventType)).toEqual(['credit.lead.created','credit.lead.documents.overdue'])
  const list=await s.app.request('http://localhost/api/credit-leads',{headers:s.headers},s.env)
  expect(await list.json()).toMatchObject({total:1})
 })
 it('handles identical retry, changed content, and duplicate collection-link identity',async()=>{
  const s=await setup();await s.request(creation);await s.request(overdue)
  const retry=await s.request({...overdue,eventId:overdue.eventId.toUpperCase()});expect(retry.status).toBe(200)
  expect(await retry.json()).toMatchObject({duplicate:true})
  expect((await s.request({...overdue,data:{...overdue.data,message:'changed'}})).status).toBe(409)
  expect((await s.request({...overdue,eventId:crypto.randomUUID()})).status).toBe(409)
  expect(await s.count('credit_events')).toBe(2);expect(await s.count('sailer_deliveries')).toBe(2)
 })
 it('allows separate collection links for the same lead',async()=>{
  const s=await setup();await s.request(creation);await s.request(overdue)
  expect((await s.request({...overdue,eventId:crypto.randomUUID(),data:{...overdue.data,collectionLinkId:'8'}})).status).toBe(201)
  expect(await s.count('credit_leads')).toBe(1);expect(await s.count('credit_lifecycle_events')).toBe(2)
 })
 it('holds out-of-order alerts and resolves their phone atomically when creation arrives',async()=>{
  const s=await setup();expect((await s.request(overdue)).status).toBe(201)
  expect((await s.db.execute('SELECT status,last_error_code,payload FROM sailer_deliveries')).rows[0]).toMatchObject({status:'blocked',last_error_code:'missing_lead',payload:null})
  expect(await s.count('credit_leads')).toBe(0)
  await s.request(creation)
  const row=(await s.db.execute({sql:'SELECT d.status,d.payload FROM sailer_deliveries d JOIN credit_events e ON e.id=d.event_pk WHERE e.event_id=?',args:[overdue.eventId]})).rows[0]!
  expect(row.status).toBe('pending');expect(JSON.parse(String(row.payload)).data.phoneNumber).toBe(creation.data.phoneNumber)
  expect((await s.request(overdue)).status).toBe(200)
 })
 it('blocks missing stored phones instead of sending incomplete alerts',async()=>{
  const s=await setup();await s.request({...creation,data:{...creation.data,phoneNumber:null}});await s.request(overdue)
  const row=(await s.db.execute({sql:'SELECT d.status,d.last_error_code FROM sailer_deliveries d JOIN credit_events e ON e.id=d.event_pk WHERE e.event_id=?',args:[overdue.eventId]})).rows[0]!
  expect(row).toMatchObject({status:'blocked',last_error_code:'invalid_phone'})
 })
 it('enforces the existing origin permission using the linked lead',async()=>{
  const s=await setup(['PUBLICA'])
  await s.store.ingest(normalizeCreatedEvent({...creation,data:{...creation.data,origem:'IB'}}))
  expect((await s.request(overdue)).status).toBe(403)
  expect(await s.count('credit_lifecycle_events')).toBe(0)
 })
 it('does not accept an unknown-origin alert through a restricted credential',async()=>{
  const s=await setup(['PUBLICA']);expect((await s.request(overdue)).status).toBe(403)
  expect(await s.count('credit_events')).toBe(0)
 })
 it('rolls back alert and event when outgoing queue insertion fails',async()=>{
  const s=await setup();await s.request(creation)
  await s.db.execute("CREATE TRIGGER fail_alert_job BEFORE INSERT ON sailer_deliveries BEGIN SELECT RAISE(ABORT,'failure'); END")
  expect((await s.request(overdue)).status).toBe(503)
  expect(await s.count('credit_lifecycle_events')).toBe(0);expect(await s.count('credit_events')).toBe(1)
 })
 it('deduplicates concurrent retries across independent connections',async()=>{
  const s=await setup();await s.store.ingest(normalizeCreatedEvent(creation))
  const event=normalizeDocumentsOverdueEvent(overdue)
  const other=createCreditStore(s.other,{sailerEnabled:true})
  const results=await Promise.all([s.store.ingest(event),other.ingest(event)])
  expect(results.sort()).toEqual([false,true]);expect(await s.count('credit_lifecycle_events')).toBe(1)
 })
 it.each([{thresholdHours:true},{thresholdHours:25},{thresholdHours:'24'},{phoneNumber:'71999999999'},{origem:'PUBLICA'},{requestedAt:'2026-11-16T15:00:00'},{collectionLinkId:7},{unknown:1}])('rejects invalid overdue contract %j',change=>{
  expect(()=>normalizeEvent({...overdue,data:{...overdue.data,...change}})).toThrow()
 })
 it('rejects unsupported event types instead of reclassifying them',()=>{expect(()=>normalizeEvent({...overdue,eventType:'credit.other'})).toThrow()})
})
