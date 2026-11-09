import { randomBytes, createHash } from 'node:crypto'
const client_id = process.argv[2]
if (!client_id || !/^[A-Za-z0-9_.-]{1,128}$/.test(client_id)) throw new Error('Usage: node scripts/issue-credit-key.js <client-id>')
const key = randomBytes(48).toString('base64url')
console.log(JSON.stringify({client_id, secret:key, key_sha256:createHash('sha256').update(key).digest('hex')},null,2))
