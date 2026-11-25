import { sailerPayload } from './sailer-contract'
import {lifecycle,suppressResolvedDeliveries,suppressExpiredDeliveries} from './credit-lifecycle'
import { createClient, type Client, type InValue } from '@libsql/client/web'
import { canonicalEvent, normalizeEvent, origins, CreditError, type CreditEvent } from './credit-schema'
import type { Credential } from './credit-auth'
export function createCreditStore(db: Client, options: {sailerEnabled?:boolean} = {}) {
  const find = async (e: CreditEvent) => (await db.execute({sql:'SELECT payload FROM credit_events WHERE producer=? AND event_id=?',args:[e.producer,e.eventId]})).rows[0]
  const duplicate = (payload: unknown, e: CreditEvent) => {
    if (canonicalEvent(JSON.parse(String(payload))) !== canonicalEvent(e)) throw new CreditError(409,'Event identity conflict')
    return true
  }
  async function beginWrite() {
    for(let attempt=0;attempt<5;attempt++) {
      try {return await db.transaction('write')} catch(error) {
        if((error as {code?:string}).code!=='SQLITE_BUSY' || attempt===4)throw error
        // A competing writer may be committing this same event. Retry acquiring
        // the transaction; uniqueness constraints still decide the outcome.
        await new Promise(resolve=>setTimeout(resolve,10*(attempt+1)))
      }
    }
    throw new Error('Unable to acquire credit transaction')
  }
  return {
    async ready() {
      await db.execute('SELECT id FROM credit_events LIMIT 1')
      await db.execute('SELECT id FROM credit_lifecycle_events LIMIT 1')
      if(options.sailerEnabled) {
        await db.execute('SELECT id FROM sailer_deliveries LIMIT 1')
        const gate=await db.execute('SELECT id FROM sailer_delivery_rate WHERE id=1')
        if(!gate.rows.length)throw new Error('Missing Sailer rate gate')
      }
    },
    async ingest(e: CreditEvent, credential?:Credential) {
      const cycle=lifecycle(e)
      if(e.eventType!=='credit.lead.created' && credential) {
        const lead=(await db.execute({sql:'SELECT origem FROM credit_leads WHERE producer=? AND lead_id=?',args:[e.producer,e.data.leadId]})).rows[0]
        const origin=e.data.origem ?? (lead?String(lead.origem):null)
        if(!credential.producers.includes(e.producer) || (origin ? !credential.origins.includes(origin) : !origins.every(value=>credential.origins.includes(value))) || (lead && e.data.origem && e.data.origem!==lead.origem))throw new CreditError(403,'Forbidden')
      }
      const previous = await find(e)
      if (previous) return duplicate(previous.payload,e)
      const tx = await beginWrite()
      try {
        const storedLead=e.eventType!=='credit.lead.created'?(await tx.execute({sql:'SELECT data FROM credit_leads WHERE producer=? AND lead_id=?',args:[e.producer,e.data.leadId]})).rows[0]:undefined
        const inserted = await tx.execute({sql:'INSERT INTO credit_events(producer,event_id,payload,received_at) VALUES(?,?,?,?) RETURNING id',args:[e.producer,e.eventId,canonicalEvent(e),new Date().toISOString()]})
        if(e.eventType==='credit.lead.created') {
          await tx.execute({sql:'INSERT INTO credit_leads(event_pk,producer,lead_id,origem,status,created_at,data) VALUES(?,?,?,?,?,?,?)',args:[inserted.rows[0]!.id,e.producer,e.data.leadId,e.data.origem,e.data.status,e.data.createdAt,JSON.stringify(e.data)]})
        } else {
          await tx.execute({sql:'INSERT INTO credit_lifecycle_events(event_pk,producer,lead_id,event_type,kind,reference_id,reminder_number) VALUES(?,?,?,?,?,?,?)',args:[inserted.rows[0]!.id,e.producer,e.data.leadId,e.eventType,cycle!.kind,cycle!.referenceId,cycle!.reminderNumber]})
        }
        if(options.sailerEnabled && e.eventType!=='credit.lead.reminders.resolved') {
          const payload=sailerPayload(e,storedLead?JSON.parse(String(storedLead.data)).phoneNumber:null)
          await tx.execute({sql:'INSERT INTO sailer_deliveries(event_pk,payload,status,next_attempt_ms,last_error_code) VALUES(?,?,?,?,?)',args:[inserted.rows[0]!.id,payload?JSON.stringify(payload):null,payload?'pending':'blocked',Date.now(),payload?null:(e.eventType!=='credit.lead.created'&&!e.data.phoneNumber&&!storedLead?'missing_lead':'invalid_phone')]})
        }
        if(options.sailerEnabled && e.eventType==='credit.lead.created') {
          // Backward-compatible recovery for old document alerts that had no phone.
          const waiting=await tx.execute({sql:`SELECT d.id,ev.payload FROM sailer_deliveries d JOIN credit_lifecycle_events a ON a.event_pk=d.event_pk
            JOIN credit_events ev ON ev.id=a.event_pk WHERE a.producer=? AND a.lead_id=? AND d.status='blocked' AND d.last_error_code='missing_lead'`,args:[e.producer,e.data.leadId]})
          for(const row of waiting.rows) {
            const alert=normalizeEvent(JSON.parse(String(row.payload)))
            const payload=sailerPayload(alert,e.data.phoneNumber)
            await tx.execute({sql:'UPDATE sailer_deliveries SET payload=?,status=?,last_error_code=?,next_attempt_ms=? WHERE id=?',args:[payload?JSON.stringify(payload):null,payload?'pending':'blocked',payload?null:'invalid_phone',Date.now(),row.id]})
          }
        }
        // Also cancel old deliveries when forwarding is paused. Never forward control events.
        if(e.eventType==='credit.lead.reminders.resolved' || options.sailerEnabled) {
          await tx.execute(suppressResolvedDeliveries)
          await tx.execute({sql:suppressExpiredDeliveries,args:[new Date().toISOString()]})
        }
        await tx.commit()
        return false
      } catch (error) {
        await tx.rollback()
        const err = error as {code?: string; message?: string}
        const expected = err.code?.startsWith('SQLITE_CONSTRAINT') && /UNIQUE constraint failed: credit_(events\.producer, credit_events\.event_id|leads\.producer, credit_leads\.lead_id|lifecycle_events\.producer, credit_lifecycle_events\.lead_id, credit_lifecycle_events\.event_type, credit_lifecycle_events\.reference_id, credit_lifecycle_events\.reminder_number)/.test(err.message ?? '')
        if (!expected) throw error
        const winner = await find(e)
        if (winner) return duplicate(winner.payload,e)
        throw new CreditError(409,cycle?'Lifecycle event already created':'Lead already created')
      } finally { tx.close() }
    },
    async query(credential: Credential, filters: Record<string,string>, leadId?: string) {
      const conditions = [`producer IN (${credential.producers.map(()=>'?').join(',')})`, `origem IN (${credential.origins.map(()=>'?').join(',')})`]
      const args: InValue[] = [...credential.producers,...credential.origins]
      for (const [key,column,operator] of [['producer','producer','='],['origem','origem','='],['status','status','='],['lead_id','lead_id','='],['created_from','created_at','>='],['created_to','created_at','<=']]) {
        if (filters[key!]) { conditions.push(`${column} ${operator} ?`); args.push(filters[key!]!) }
      }
      if (leadId !== undefined) { conditions.push('lead_id = ?'); args.push(leadId) }
      const where = conditions.join(' AND ')
      const item = (row: Record<string,unknown>) => {
        const data = JSON.parse(String(row.data))
        // Explicit allowlist shared by list and detail; never spread the stored snapshot.
        return {
          name: data.name ?? null,
          email: data.email ?? null,
          phoneNumber: data.phoneNumber ?? null,
          birthDate: data.birthDate ?? null,
          taxNumber: data.taxNumber ?? null,
        }
      }
      if (leadId !== undefined) {
        const row = (await db.execute({sql:`SELECT producer,data FROM credit_leads WHERE ${where} LIMIT 1`,args})).rows[0]
        if (!row) throw new CreditError(404,'Lead not found')
        return item(row)
      }
      const page = Number(filters.page ?? 1), size = Number(filters.page_size ?? 50)
      // A read transaction keeps the count and page on one snapshot.
      const tx = await db.transaction('read')
      try {
        const total = (await tx.execute({sql:`SELECT count(*) AS total FROM credit_leads WHERE ${where}`,args})).rows[0]!.total
        const rows = await tx.execute({sql:`SELECT producer,data FROM credit_leads WHERE ${where} ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`,args:[...args,size,(page-1)*size]})
        await tx.commit()
        return {items:rows.rows.map(item),page,pageSize:size,total:Number(total)}
      } finally { tx.close() }
    }
  }
}
export const connectCreditStore = (url: string, authToken?: string, options: {sailerEnabled?:boolean} = {}) => createCreditStore(createClient({url,authToken}), options)
export type CreditStore = ReturnType<typeof createCreditStore>
