import './load-local-env.js'
import {createClient} from '@libsql/client'
if(!process.env.TURSO_DATABASE_URL)throw new Error('Missing TURSO_DATABASE_URL')
const db=createClient({url:process.env.TURSO_DATABASE_URL,authToken:process.env.TURSO_AUTH_TOKEN})
try {
  const counts=await db.execute('SELECT status,count(*) AS total FROM sailer_deliveries GROUP BY status')
  const recent=await db.execute(`SELECT e.event_id,json_extract(e.payload,'$.eventType') AS event_type,d.status,d.attempts,d.last_http_status,d.last_error_code,d.delivered_at
    FROM sailer_deliveries d JOIN credit_events e ON e.id=d.event_pk ORDER BY d.id DESC LIMIT 20`)
  console.log(JSON.stringify({counts:counts.rows,recent:recent.rows},null,2))
}finally{db.close()}
