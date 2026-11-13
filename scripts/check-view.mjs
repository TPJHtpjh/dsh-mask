/**
 * Compare one `Tool.listTools` payload against the deny list.
 *
 * Prints the visible count, which deny names are present, and which are gone.
 * Used to compare an Agent's own view before and after a mask install.
 *
 * Usage: node scripts/check-view.mjs <listTools.json> [deny.json]
 */

import { readFileSync } from 'node:fs';

import { denyList } from '../lib/index.js';

const source = process.argv[2];
if (source === undefined) {
  console.error('usage: node scripts/check-view.mjs <listTools.json> [deny.json]');
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
  ? denyList()
  : JSON.parse(readFileSync(process.argv[3], 'utf8'));

const present = deny.filter((name) => live.includes(name));
const gone = deny.filter((name) => !live.includes(name));

console.log(`TOTAL: ${live.length}`);
console.log(`DENY_PRESENT: ${present.length}`);
console.log(`DENY_GONE: ${gone.length}`);
console.log(`PRESENT_NAMES: ${present.length === 0 ? 'NONE' : present.join(', ')}`);
console.log(`GONE_NAMES: ${gone.length === 0 ? 'NONE' : gone.join(', ')}`);
