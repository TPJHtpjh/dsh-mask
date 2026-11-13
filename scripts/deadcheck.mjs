/** Report exports that nothing references, and imports that go unused. */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..', 'lib')
const files = fs.readdirSync(ROOT).filter((name) => name.endsWith('.js'))
const sources = files.map((name) => ({ name, text: fs.readFileSync(path.join(ROOT, name), 'utf8') }))
const scriptsDir = path.join(ROOT, '..', 'scripts')
const all = sources.concat(fs.readdirSync(scriptsDir).filter((n) => n.endsWith('.mjs')).map((name) => ({ name, text: fs.readFileSync(path.join(scriptsDir, name), 'utf8') })))
const corpus = all.map((entry) => entry.text).join('\n')

for (const entry of sources) {
  const exported = [...entry.text.matchAll(/export (?:async )?(?:function|const|class)\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1])
  const unused = exported.filter((name) => {
    // Count references outside this file's own declaration line.
    const re = new RegExp(`\\b${name}\\b`, 'g')
    const inFile = (entry.text.match(re) || []).length
    const elsewhere = (corpus.replace(entry.text, '').match(re) || []).length
    const declared = (entry.text.match(new RegExp(`export (?:async )?(?:function|const|class) ${name}\\b`, 'g')) || []).length
    return elsewhere === 0 && inFile <= declared
  })
  const imported = [...entry.text.matchAll(/import\s*\{([^}]*)\}\s*from/g)]
    .flatMap((m) => m[1].split(',').map((s) => s.trim().split(/\s+as\s+/).pop()).filter(Boolean))
  const dead = imported.filter((name) => {
    const re = new RegExp(`\\b${name}\\b`, 'g')
    return (entry.text.match(re) || []).length <= 1
  })
  console.log(`${entry.name.padEnd(24)} unused-imports: ${dead.join(', ') || '(none)'}   unreferenced-exports: ${unused.join(', ') || '(none)'}`)
}
