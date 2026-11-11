import ts from 'typescript'
import { readFile } from 'node:fs/promises'

const file = process.argv[2] ?? new URL('../wrangler.jsonc', import.meta.url)
const source = ts.parseJsonText(String(file), await readFile(file, 'utf8'))
if (source.parseDiagnostics.length) throw new Error('Invalid Wrangler JSON configuration')
function visit(node) {
  if (ts.isObjectLiteralExpression(node)) {
    const names = new Set()
    for (const property of node.properties) {
      const name = property.name?.text
      if (name !== undefined && names.has(name)) throw new Error(`Duplicate Wrangler configuration key: ${name}`)
      names.add(name)
    }
  }
  ts.forEachChild(node, visit)
}
visit(source)
console.log('Wrangler configuration valid: no duplicate keys')
