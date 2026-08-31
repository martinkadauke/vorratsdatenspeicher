// Writes dist/precache.json: the exact list of files the service worker must have before the app
// can open without a network.
//
// Why a generated list and not "cache whatever gets fetched": Vite code-splits, so a page the user
// has never opened lives in a chunk that was never requested and therefore never cached. That is
// precisely the shopping list on the phone of someone who only ever opens Statistik at home — the
// app would come up and then fail on the one screen they went offline for. The list is produced
// from what was actually built, so it cannot drift from the bundle.
//
// The build id changes with every build, which is what retires the previous cache on activate.
import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');

/** Every built file, as root-relative URLs. */
function walk(dir, base = '') {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const rel = base ? `${base}/${entry}` : entry;
    if (statSync(full).isDirectory()) out.push(...walk(full, rel));
    else out.push(`/${rel.split(path.sep).join('/')}`);
  }
  return out;
}

// ⚠️ Excluded on purpose:
//  - sw.js itself: the browser fetches and updates it outside the cache; caching it can pin a
//    stale worker that then serves a stale app forever, which is the worst failure this file has.
//  - precache.json: same reason — the worker must always read the CURRENT list.
//  - source maps: megabytes nobody offline needs.
const SKIP = /^\/(sw\.js|precache\.json)$|\.map$/;

const files = walk(dist).filter((f) => !SKIP.test(f)).sort();
// The id is derived from the file list, so an identical build keeps its cache instead of
// re-downloading everything: on a phone that is somebody's data plan.
const buildId = createHash('sha256').update(files.join('\n')).digest('hex').slice(0, 12);

writeFileSync(path.join(dist, 'precache.json'), JSON.stringify({ buildId, files }, null, 0));

const bytes = files.reduce((n, f) => n + statSync(path.join(dist, f.slice(1))).size, 0);
console.log(`[precache] ${files.length} files, ${(bytes / 1024 / 1024).toFixed(1)} MB, build ${buildId}`);

// A guard, because the whole point is that the app OPENS offline: without index.html there is
// nothing to serve for a navigation, and the failure would only show up on a phone in a shop.
if (!files.includes('/index.html')) {
  console.error('::error::index.html missing from the build — the app could not open offline');
  process.exit(1);
}