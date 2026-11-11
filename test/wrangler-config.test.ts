import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { authenticate, parseCredentials } from '../src/credit-auth'

describe('production Wrangler credential registry',()=>{
  it('contains a single registry and rejects duplicate keys even in JSONC',()=>{
    expect(()=>execFileSync(process.execPath,['scripts/validate-wrangler-config.js'],{stdio:'pipe'})).not.toThrow()
    const directory=mkdtempSync(join(tmpdir(),'g8-wrangler-'))
    try {
      const file=join(directory,'wrangler.jsonc')
      writeFileSync(file,'{ // duplicate key would discard reader credentials\n "vars": {"API_CREDENTIALS_JSON":"first", "API_CREDENTIALS_JSON":"second"}}')
      const result=spawnSync(process.execPath,['scripts/validate-wrangler-config.js',file],{encoding:'utf8'})
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('Duplicate Wrangler configuration key: API_CREDENTIALS_JSON')
    } finally {rmSync(directory,{recursive:true,force:true})}
  })
  it('authenticates a reader from the committed deployment configuration without local env overrides',async()=>{
    const config=JSON.parse(readFileSync('wrangler.jsonc','utf8'))
    const entries=parseCredentials(config.vars.API_CREDENTIALS_JSON)
    expect(entries.find(c=>c.client_id==='cliente-reader')).toMatchObject({scopes:['read'],origins:['PUBLICA','IB','AGENTE']})
    expect(entries.find(c=>c.client_id==='whitelabel-producer-6481ddd84a33c150')).toBeDefined()
    // Exercise the deployment reader's permissions using a throwaway test secret.
    const testKey='deployment-registry-test-only'
    const fixture=entries.map(c=>c.client_id==='cliente-reader'?{...c,key_sha256:[createHash('sha256').update(testKey).digest('hex')]}:c)
    const headers=new Headers({'X-Client-Id':'cliente-reader','X-API-Key':testKey})
    await expect(authenticate(headers,fixture,'read')).resolves.toMatchObject({client_id:'cliente-reader'})
    await expect(authenticate(headers,fixture,'ingest')).rejects.toMatchObject({status:403})
  })
})
