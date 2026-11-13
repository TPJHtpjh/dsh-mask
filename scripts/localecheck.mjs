/** Report locale keys defined but never used, or used but never defined. */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const src = fs.readFileSync(path.join(HERE, '..', 'lib', 'client.js'), 'utf8')

const used = new Set([...src.matchAll(/\bt\('([A-Za-z]+)'\)/g)].map((m) => m[1]))
for (const m of src.matchAll(/fill\(t\('([A-Za-z]+)'/g)) used.add(m[1])

function dict(name) {
  const start = src.indexOf(`const ${name} = {`)
  if (start < 0) return new Set()
  let depth = 0
  const body = src.slice(src.indexOf('{', start))
  let end = 0
  for (let i = 0; i < body.length; i += 1) {
    if (body[i] === '{') depth += 1
    else if (body[i] === '}') { depth -= 1; if (depth === 0) { end = i; break } }
  }
  return new Set([...body.slice(1, end).matchAll(/^\s{6}([A-Za-z]+):/gm)].map((m) => m[1]))
}
const zh = dict('zh')
const en = dict('en')
console.log('used', used.size, '| zh', zh.size, '| en', en.size)
console.log('used but undefined in zh:', [...used].filter((k) => !zh.has(k)).join(', ') || '(none)')
console.log('used but undefined in en:', [...used].filter((k) => !en.has(k)).join(', ') || '(none)')
console.log('zh/en asymmetry:', [...new Set([...zh, ...en])].filter((k) => zh.has(k) !== en.has(k)).join(', ') || '(none)')

// Keys reached only through the BUCKET_KEYS indirection are invisible to the
// literal scan above, yet a missing one silently prints the raw key. Walk the
// indirection explicitly.
const indirect = [...src.matchAll(/^\s+(\w+):\s*'(bucket[A-Za-z]+)',/gm)].map((m) => m[2])
console.log('indirect (BUCKET_KEYS) refs:', indirect.length)
console.log('indirect but undefined:', indirect.filter((k) => !zh.has(k) || !en.has(k)).join(', ') || '(none)')

const trulyUnused = [...zh].filter((k) => !used.has(k) && !indirect.includes(k))
console.log('defined but unreachable:', trulyUnused.join(', ') || '(none)')
