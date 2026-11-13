/**
 * Compare the live tool surface against the cherry-toolfilter deny list.
 *
 * Reads the `Tool.listTools` inspect output, extracts every visible tool name, and
 * reports three things: which deny names still exist, which are already gone (and
 * therefore must not be requested), and whether any kept name was accidentally
 * included in the deny list.
 *
 * Usage: node scripts/audit-deny.mjs <listTools.json> [deny.json]
 */

import { readFileSync } from 'node:fs';

const source = process.argv[2];
if (source === undefined) {
  console.error('usage: node scripts/audit-deny.mjs <listTools.json> [deny.json]');
  process.exit(2);
}

const payload = JSON.parse(readFileSync(source, 'utf8'));
const tools = payload?.data?.tools ?? payload?.tools;
if (!Array.isArray(tools)) {
  console.error('no tools array in the payload');
  process.exit(2);
}
const live = tools.map((entry) => entry.name);

const deny = process.argv[3] === undefined
  ? (await import('../lib/index.js')).denyList()
  : JSON.parse(readFileSync(process.argv[3], 'utf8'));

const present = deny.filter((name) => live.includes(name));
const absent = deny.filter((name) => !live.includes(name));

const schemaBytes = tools.reduce((total, entry) => total + JSON.stringify(entry).length, 0);
const denySchemaBytes = tools
  .filter((entry) => present.includes(entry.name))
  .reduce((total, entry) => total + JSON.stringify(entry).length, 0);

console.log(`visible tools        ${live.length}`);
console.log(`deny names requested ${deny.length}`);
console.log(`  present            ${present.length}`);
console.log(`  already absent     ${absent.length}`);
console.log(`schema bytes total   ${schemaBytes}`);
console.log(`  removable          ${denySchemaBytes}`);
console.log(`  remaining          ${schemaBytes - denySchemaBytes}`);
if (absent.length > 0) console.log(`\nababsent (skipped by the plugin):\n  ${absent.join(', ')}`);
console.log(`\nwill be masked:\n  ${present.join(', ')}`);
