/** 只读探针：ready/idle 快照的完整字段（writable/revision 何时存在）。
 *  需要 DSH 安装目录里的 app.asar：node scripts/probe-status.mjs [path/to/app.asar]
 *  （或设 DSH_APP_ASAR；不传且未设则跳过——这是本机取证工具，不是必跑套件） */
import fs from 'node:fs'

const archive = process.argv[2] ?? process.env.DSH_APP_ASAR
if (!archive || !fs.existsSync(archive)) {
  console.log('SKIP: pass the app.asar path (or set DSH_APP_ASAR) to run this probe')
  process.exit(0)
}
const fd = fs.openSync(archive, 'r')
const header = Buffer.alloc(16)
fs.readSync(fd, header, 0, 16, 0)
const jsonSize = header.readUInt32LE(12)
const headerBuf = Buffer.alloc(jsonSize)
fs.readSync(fd, headerBuf, 0, jsonSize, 16)
const baseOffset = 16 + jsonSize
const tree = JSON.parse(headerBuf.toString('utf8').replace(/\0+$/, ''))
const hits = []
function walk(node, prefix) {
  if (node === undefined || node === null) return
  if (node.files) { for (const [name, child] of Object.entries(node.files)) walk(child, `${prefix}/${name}`); return }
  if (typeof node.size === 'number' && node.offset !== undefined) hits.push({ p: prefix, off: Number(node.offset), size: node.size })
}
walk(tree, '')
function extract(offset, size) {
  const buf = Buffer.alloc(size)
  fs.readSync(fd, buf, 0, size, baseOffset + offset)
  return buf.toString('utf8')
}
const target = hits.find((h) => h.p === '/dsh/node_modules/@deepseek-ai/dsh-client-ui-settings/lib/client.js')
const text = extract(target.off, target.size)

// The namespace snapshot builder: where status/writable/revision are produced together.
const m = text.match(/derive\(\)[\s\S]{0,1600}/)
if (m !== null) console.log('--- derive ---\n', m[0].replace(/\s+/g, ' ').slice(0, 1500))
console.log('\n--- writable sites ---')
for (const w of text.matchAll(/.{0,120}writable.{0,120}/g)) {
  console.log('  ', w[0].replace(/\s+/g, ' '))
}
fs.closeSync(fd)
