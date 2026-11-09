import './load-local-env.js'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const args = process.argv.slice(2)
if (!args.some(arg => arg === '--port' || arg.startsWith('--port='))) {
  args.push('--port', process.env.PORT || '3000')
}
const cli = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url))
const child = spawn(process.execPath, [cli, 'dev', ...args], { stdio: 'inherit', env: process.env })
child.on('error', () => { console.error('Unable to start Wrangler'); process.exitCode = 1 })
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0) })
