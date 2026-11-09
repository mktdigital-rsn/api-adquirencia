import { CreditError, origins, producer } from './credit-schema'
export type Credential = { client_id: string; key_sha256: string[]; scopes: string[]; producers: string[]; origins: string[] }
export function parseCredentials(raw: string | undefined): Credential[] {
  const fail = () => { throw new Error('Invalid API_CREDENTIALS_JSON configuration') }
  let entries: unknown
  try { entries = JSON.parse(raw ?? '') } catch { return fail() }
  if (!Array.isArray(entries) || !entries.length) return fail()
  const ids = new Set<string>()
  for (const c of entries) {
    if (!c || typeof c !== 'object' || Object.keys(c).some(k => !['client_id','key_sha256','scopes','producers','origins'].includes(k)) || typeof c.client_id !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(c.client_id) || ids.has(c.client_id)) return fail()
    ids.add(c.client_id)
    for (const key of ['key_sha256','scopes','producers','origins']) if (!Array.isArray(c[key]) || !c[key].length) return fail()
    if (c.key_sha256.some((h: unknown) => typeof h !== 'string' || !/^[a-f0-9]{64}$/.test(h)) || c.scopes.some((s: string) => !['ingest','read'].includes(s)) || c.producers.some((p: string) => p !== producer) || c.origins.some((o: string) => !origins.includes(o))) return fail()
  }
  return entries
}
export async function authenticate(headers: Headers, entries: Credential[], scope: string) {
  const id = headers.get('x-client-id'), key = headers.get('x-api-key')
  if (!id || !key || id.includes(',') || key.includes(',') || /\s/.test(key)) throw new CreditError(401,'Invalid credentials')
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(key))), b => b.toString(16).padStart(2,'0')).join('')
  const credential = entries.find(c => c.client_id === id)
  // WebCrypto verification provides the runtime's constant-time comparison.
  let valid = false
  for (const expected of credential?.key_sha256 ?? ['0'.repeat(64)]) {
    const hmac = await crypto.subtle.importKey('raw', new TextEncoder().encode(hash), {name:'HMAC',hash:'SHA-256'}, false, ['sign','verify'])
    const signature = await crypto.subtle.sign('HMAC', hmac, new TextEncoder().encode(expected))
    valid = (await crypto.subtle.verify('HMAC',hmac,signature,new TextEncoder().encode(hash))) || valid
  }
  if (!credential || !valid) throw new CreditError(401,'Invalid credentials')
  if (!credential.scopes.includes(scope)) throw new CreditError(403,'Forbidden')
  return credential
}
