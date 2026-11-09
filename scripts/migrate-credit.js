import './load-local-env.js'
import { createClient } from '@libsql/client'
import { readFile, readdir } from 'node:fs/promises'
const url = process.env.TURSO_DATABASE_URL
if (!url) throw new Error('Missing TURSO_DATABASE_URL')
const db = createClient({url,authToken:process.env.TURSO_AUTH_TOKEN})
try {
  const directory = new URL('../migrations/', import.meta.url)
  const names = (await readdir(directory)).filter(name => /^\d+.*\.sql$/.test(name)).sort()
  const sql = (await Promise.all(names.map(name => readFile(new URL(name, directory), 'utf8')))).join('\n')
  await db.batch(sql.split(';').map(s=>s.trim()).filter(Boolean),'write')
  console.log('Credit schema migrated')
} finally { db.close() }
