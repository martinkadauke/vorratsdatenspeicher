#!/usr/bin/env node
// Does the installer actually CONTAIN every file the shell imports?
//
// ⚠️ electron-builder's `files:` is an allow-list, not a directory copy. Adding an import to
// boot.mjs without adding the file there yields an installer that builds green, installs cleanly,
// and then dies on the user's first launch with a module-not-found — while every local test passes,
// because a dev checkout has the file sitting right next to the importer. v0.37.0 shipped exactly
// that: searxng.mjs was imported and not packaged, and the release had to be withdrawn.
//
// So: start at the entry points, follow relative imports transitively, and insist that each file
// found this way is covered by the allow-list. Runs in a second, needs no build.
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRIES = ['main.mjs', 'boot.mjs'];

/** The `files:` block of electron-builder.yml, as plain strings. Deliberately a small hand-rolled
 *  reader rather than a YAML dependency: this must run before anything is installed or built. */
function allowList() {
  const yml = readFileSync(path.join(desktopDir, 'electron-builder.yml'), 'utf8').split(/\r?\n/);
  const start = yml.findIndex(l => l.trim() === 'files:');
  if (start < 0) throw new Error('electron-builder.yml has no files: block');
  const out = [];
  for (const line of yml.slice(start + 1)) {
    const m = /^\s+-\s+(.+?)\s*$/.exec(line);
    if (!m) { if (line.trim() && !line.startsWith(' ')) break; else continue; }
    out.push(m[1]);
  }
  return out;
}

/** Every local module reachable from the entry points. */
function reachable() {
  const seen = new Set();
  const queue = [...ENTRIES];
  while (queue.length) {
    const rel = queue.shift();
    if (seen.has(rel)) continue;
    const abs = path.join(desktopDir, rel);
    if (!existsSync(abs)) continue;
    seen.add(rel);
    const src = readFileSync(abs, 'utf8');
    // Static imports and dynamic import() of RELATIVE paths — node_modules is covered wholesale.
    for (const m of src.matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g)) {
      queue.push(path.normalize(path.join(path.dirname(rel), m[1])).split(path.sep).join('/'));
    }
  }
  return [...seen];
}

const allowed = allowList();
const covered = (rel) => allowed.some(p => p === rel || (p.includes('*') && new RegExp(
  '^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\/\*/g, '.*').replace(/\*/g, '[^/]*') + '$',
).test(rel)));

const missing = reachable().filter(rel => !covered(rel));
if (missing.length) {
  console.error('[packaging] MISSING from electron-builder files: ' + missing.join(', '));
  console.error('[packaging] the installer would build fine and the app would not start.');
  process.exit(1);
}
console.log(`[packaging] OK — all ${reachable().length} shell modules are packaged`);
