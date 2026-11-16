import { createClient, type Client } from '@libsql/client/web'
import type { AppEnv } from './env'
import { sailerConfig } from './sailer-contract'

const MAX_ATTEMPTS = 10
const RETRY_WINDOW_MS = 6 * 24 * 60 * 60 * 1000 // Sailer forgets event IDs after seven days.
const SPACING_MS = 400 // shared DB gate: <=150 dispatch reservations/minute, below the 200/minute limit.

type Claim = {id:number;eventId:string;payload:string;token:string;attempts:number;firstAttempt:number}
export function createSailerDelivery(db: Client, options: {
  url:string; token:string; fetchImpl?:typeof fetch; now?:()=>number; sleep?:(ms:number)=>Promise<void>; uuid?:()=>string
}) {
  const {url,token,fetchImpl=fetch,now=Date.now,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),uuid=()=>crypto.randomUUID()}=options
  async function claim(): Promise<{job?:Claim;wait?:number}> {
    let tx
    try {tx=await db.transaction('write')} catch(error) {
      if((error as {code?:string}).code==='SQLITE_BUSY')return {}
      throw error
    }
    try {
      const instant=now()
      await tx.execute({sql:`UPDATE sailer_deliveries SET status='failed',claim_token=NULL,lease_until_ms=NULL,last_error_code='retry_limit'
        WHERE (status='pending' OR (status='processing' AND lease_until_ms<=?))
        AND (attempts>=? OR (first_attempt_ms IS NOT NULL AND first_attempt_ms<=?))`,args:[instant,MAX_ATTEMPTS,instant-RETRY_WINDOW_MS]})
      const row=(await tx.execute({sql:`SELECT d.id,d.payload,d.attempts,d.first_attempt_ms,e.event_id FROM sailer_deliveries d
        JOIN credit_events e ON e.id=d.event_pk
        WHERE (d.status='pending' AND d.next_attempt_ms<=?) OR (d.status='processing' AND d.lease_until_ms<=?)
        ORDER BY d.next_attempt_ms,d.id LIMIT 1`,args:[instant,instant]})).rows[0]
      if (!row) {await tx.commit();return {}}
      const gate=(await tx.execute('SELECT next_send_ms FROM sailer_delivery_rate WHERE id=1')).rows[0]
      if (!gate) throw new Error('Missing Sailer rate gate')
      const wait=Number(gate.next_send_ms)-instant
      if (wait>0) {await tx.commit();return {wait}}
      const claimToken=uuid(),firstAttempt=row.first_attempt_ms===null?instant:Number(row.first_attempt_ms)
      await tx.execute({sql:'UPDATE sailer_delivery_rate SET next_send_ms=? WHERE id=1',args:[instant+SPACING_MS]})
      await tx.execute({sql:`UPDATE sailer_deliveries SET status='processing',attempts=attempts+1,first_attempt_ms=?,claim_token=?,lease_until_ms=? WHERE id=?`,args:[firstAttempt,claimToken,instant+120000,row.id]})
      await tx.commit()
      return {job:{id:Number(row.id),eventId:String(row.event_id),payload:String(row.payload),token:claimToken,attempts:Number(row.attempts)+1,firstAttempt}}
    } catch(error) {
      await tx.rollback()
      if((error as {code?:string}).code==='SQLITE_BUSY')return {}
      throw error
    } finally {tx.close()}
  }
  async function deliver(job: Claim) {
    let status:number|null=null,delivered=false,retryable=true,code='network_error',retryAfter=0
    const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),10000)
    try {
      const response=await fetchImpl(url,{method:'POST',headers:{'Content-Type':'application/json','X-API-Key':token},body:job.payload,redirect:'manual',signal:controller.signal})
      status=response.status
      delivered=status>=200 && status<300
      retryable=status===408 || status===429 || status>=500
      code=delivered?'delivered':'http_'+status
      const raw=response.headers.get('Retry-After')
      if(raw) {
        const value=/^\d+$/.test(raw)?Number(raw)*1000:Date.parse(raw)-now()
        if(Number.isFinite(value))retryAfter=Math.max(0,value)
      }
      // Neither persist nor log the partner's response body: it may contain personal data.
      await response.body?.cancel()
    } catch { /* Includes timeout and network errors; stable payload is retried. */ }
    finally {clearTimeout(timeout)}
    const instant=now(),delay=Math.max(retryAfter,Math.min(3600000,10000*2**(job.attempts-1)))
    const next=instant+delay
    const expired=next>=job.firstAttempt+RETRY_WINDOW_MS || job.attempts>=MAX_ATTEMPTS
    const state=delivered?'delivered':retryable?(expired?'failed':'pending'):'blocked'
    const updated=await db.execute({sql:`UPDATE sailer_deliveries SET status=?,next_attempt_ms=?,claim_token=NULL,lease_until_ms=NULL,
      delivered_at=?,last_http_status=?,last_error_code=? WHERE id=? AND status='processing' AND claim_token=?`,args:[state,next,delivered?new Date(instant).toISOString():null,status,delivered?null:code,job.id,job.token]})
    if(updated.rowsAffected && (status===429 || (status===503 && retryAfter>0))) {
      await db.execute({sql:'UPDATE sailer_delivery_rate SET next_send_ms=max(next_send_ms,?) WHERE id=1',args:[next]})
    }
    if(updated.rowsAffected) console.info(JSON.stringify({result:'sailer_'+state,eventId:job.eventId,attempt:job.attempts,httpStatus:status}))
    return status===401 || status===403 || status===429 || (status===503 && retryAfter>0)
  }
  return {
    async drain(limit=20) {
      // Persisted claims, leases and a global rate gate coordinate independent Workers.
      let handled=0,waits=0
      while(handled<Math.min(20,limit)) {
        const result=await claim()
        if(result.wait!==undefined) {
          if(++waits>40 || result.wait>SPACING_MS)break
          await sleep(result.wait);continue
        }
        if(!result.job)break
        const stop=await deliver(result.job);handled++
        if(stop)break
      }
      return handled
    }
  }
}
export async function dispatchSailer(env:AppEnv,limit=20) {
  const config=sailerConfig(env)
  if(!config.enabled)return
  if(!env.TURSO_DATABASE_URL)throw new Error('Missing Sailer database configuration')
  const db=createClient({url:env.TURSO_DATABASE_URL,authToken:env.TURSO_AUTH_TOKEN})
  try {return await createSailerDelivery(db,config).drain(limit)} finally {db.close()}
}
export function reportSailerFailure() {console.warn(JSON.stringify({result:'sailer_worker_unavailable'}))}
