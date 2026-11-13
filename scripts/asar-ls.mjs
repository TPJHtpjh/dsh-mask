// List files inside app.asar matching a substring, using the measured header
// layout: uint32 pickle at offset 4, header JSON size at readUInt32LE(12),
// baseOffset = 16 + jsonSize. Read-only probe; keeps asar archaeology repeatable.
import { openSync, readSync, closeSync } from 'node:fs';

const asar = process.argv[2] ?? process.env.DSH_APP_ASAR;
const needle = process.argv[3] ?? 'dsh-skill';
if (!asar) {
  console.error('usage: node scripts/asar-ls.mjs <path/to/app.asar> [needle]   (or set DSH_APP_ASAR)');
  process.exit(2);
}

const fd = openSync(asar, 'r');
try {
  const head = Buffer.alloc(16);
  readSync(fd, head, 0, 16, 0);
  const jsonSize = head.readUInt32LE(12);
  const jsonBuf = Buffer.alloc(jsonSize);
  readSync(fd, jsonBuf, 0, jsonSize, 16);
  const header = JSON.parse(jsonBuf.toString('utf8'));
  const baseOffset = 16 + jsonSize;
  const out = [];
  const walk = (node, prefix) => {
    if (!node || typeof node !== 'object') return;
    if (node.files) {
      for (const [name, child] of Object.entries(node.files)) {
        const p = prefix === '' ? name : `${prefix}/${name}`;
        if (child.files) walk(child, p);
        else if (p.includes(needle)) out.push(`${p}\t${child.size ?? '?'}\t${baseOffset + Number(child.offset ?? 0)}`);
      }
    }
  };
  walk(header, '');
  console.log(out.join('\n') || '(no matches)');
  console.log(`total matches: ${out.length}`);
} finally {
  closeSync(fd);
}
