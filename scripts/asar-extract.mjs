// Extract one file from app.asar by (offset,size) from asar-ls.mjs output and
// write it to a temp path so the read tool can open it. Read-only on the asar.
import { openSync, readSync, closeSync, writeFileSync } from 'node:fs';

const [, , asarPath, offsetStr, sizeStr, outPath] = process.argv;
const fd = openSync(asarPath, 'r');
try {
  const size = Number(sizeStr);
  const buf = Buffer.alloc(size);
  let read = 0;
  while (read < size) {
    const got = readSync(fd, buf, read, size - read, Number(offsetStr) + read);
    if (got <= 0) break;
    read += got;
  }
  writeFileSync(outPath, buf.subarray(0, read));
  console.log(`wrote ${read} bytes to ${outPath}`);
} finally {
  closeSync(fd);
}
