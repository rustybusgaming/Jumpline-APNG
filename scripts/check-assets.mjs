/*
 * Verifies every local file index.html points at actually exists, so a renamed
 * or forgotten script is caught by CI rather than by a blank page.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');

const refs = [...html.matchAll(/(?:src|href)\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
const local = refs.filter((r) => !/^(https?:)?\/\//.test(r) && !r.startsWith('data:') && !r.startsWith('#'));

let missing = 0;
for (const ref of local) {
  const path = join(root, ref.split(/[?#]/)[0]);
  if (existsSync(path)) {
    console.log(`  ok      ${ref}`);
  } else {
    console.log(`  MISSING ${ref}`);
    missing++;
  }
}

if (!local.length) {
  console.error('No local references found in index.html, which cannot be right.');
  process.exit(1);
}
console.log(`\n${local.length - missing}/${local.length} local references resolve`);
process.exit(missing ? 1 : 0);
