import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

// Match Wrangler's local secret-file preference; exported variables take precedence.
export function loadLocalEnv(directory = fileURLToPath(new URL('../', import.meta.url))) {
  const path = ['.dev.vars', '.env'].map(name => join(directory, name)).find(existsSync)
  if (!path) return
  if (!process.loadEnvFile) throw new Error('Local configuration loading requires Node.js 20.12 or newer')
  process.loadEnvFile(path)
}
loadLocalEnv()
