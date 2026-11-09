import './load-local-env.js'
import ts from 'typescript'
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const directory = await mkdtemp(join(tmpdir(), 'credit-config-'))
try {
  if (!process.env.TURSO_DATABASE_URL) throw new Error('Missing TURSO_DATABASE_URL')
  for (const name of ['credit-schema','credit-auth']) {
    const source = await readFile(new URL(`../src/${name}.ts`,import.meta.url),'utf8')
    const {outputText} = ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ESNext,module:ts.ModuleKind.ESNext}})
    await writeFile(join(directory,`${name}.mjs`),outputText.replaceAll("'./credit-schema'","'./credit-schema.mjs'"))
  }
  const {parseCredentials} = await import(pathToFileURL(join(directory,'credit-auth.mjs')).href)
  parseCredentials(process.env.API_CREDENTIALS_JSON)
  console.log('Credit configuration valid')
} finally { await rm(directory,{recursive:true,force:true}) }
