import './load-local-env.js'
import {createClient} from '@libsql/client'
const eventId=process.argv[2]
if(!eventId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(eventId))throw new Error('Usage: npm run sailer:retry -- <event UUID>')
if(!process.env.TURSO_DATABASE_URL)throw new Error('Missing TURSO_DATABASE_URL')
const db=createClient({url:process.env.TURSO_DATABASE_URL,authToken:process.env.TURSO_AUTH_TOKEN})
try {
  const now=Date.now()
  // Same payload and ID, within the original six-day window; never replay delivered jobs.
  const result=await db.execute({sql:`UPDATE sailer_deliveries SET status='pending',attempts=0,next_attempt_ms=?,last_error_code=NULL
    WHERE event_pk IN (SELECT id FROM credit_events WHERE event_id=?) AND status IN ('blocked','failed')
    AND payload IS NOT NULL AND (first_attempt_ms IS NULL OR first_attempt_ms>?)`,args:[now,eventId.toLowerCase(),now-6*86400000]})
  console.log(JSON.stringify({requeued:result.rowsAffected}))
}finally{db.close()}
