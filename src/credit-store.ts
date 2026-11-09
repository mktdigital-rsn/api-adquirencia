import { createClient, type Client, type InValue } from '@libsql/client/web'
import { canonicalEvent, CreditError, type CreditEvent } from './credit-schema'
import type { Credential } from './credit-auth'
export function createCreditStore(db: Client) {
  const find = async (e: CreditEvent) => (await db.execute({sql:'SELECT payload FROM credit_events WHERE producer=? AND event_id=?',args:[e.producer,e.eventId]})).rows[0]
  const duplicate = (payload: unknown, e: CreditEvent) => {
    if (canonicalEvent(JSON.parse(String(payload))) !== canonicalEvent(e)) throw new CreditError(409,'Event identity conflict')
    return true
  }
  return {
    async ready() { await db.execute('SELECT id FROM credit_events LIMIT 1') },
    async ingest(e: CreditEvent) {
      const previous = await find(e)
      if (previous) return duplicate(previous.payload,e)
      const tx = await db.transaction('write')
      try {
        const inserted = await tx.execute({sql:'INSERT INTO credit_events(producer,event_id,payload,received_at) VALUES(?,?,?,?) RETURNING id',args:[e.producer,e.eventId,canonicalEvent(e),new Date().toISOString()]})
        await tx.execute({sql:'INSERT INTO credit_leads(event_pk,producer,lead_id,origem,status,created_at,data) VALUES(?,?,?,?,?,?,?)',args:[inserted.rows[0]!.id,e.producer,e.data.leadId,e.data.origem,e.data.status,e.data.createdAt,JSON.stringify(e.data)]})
        await tx.commit()
        return false
      } catch (error) {
        await tx.rollback()
        const err = error as {code?: string; message?: string}
        const expected = err.code?.startsWith('SQLITE_CONSTRAINT') && /UNIQUE constraint failed: credit_(events\.producer, credit_events\.event_id|leads\.producer, credit_leads\.lead_id)/.test(err.message ?? '')
        if (!expected) throw error
        const winner = await find(e)
        if (winner) return duplicate(winner.payload,e)
        throw new CreditError(409,'Lead already created')
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
export const connectCreditStore = (url: string, authToken?: string) => createCreditStore(createClient({url,authToken}))
export type CreditStore = ReturnType<typeof createCreditStore>
