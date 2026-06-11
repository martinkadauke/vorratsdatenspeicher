#!/usr/bin/env node
/**
 * VDS Receipt Re-Import Tool
 *
 * Walks the receipt photo directory, sends every image to Claude (vision),
 * extracts structured receipt data, and writes it into the target database
 * the same way the n8n Einkaufszettelpuppe workflow does — but with Claude's
 * stronger OCR + reasoning. Canonical names are intentionally left NULL so
 * the in-app churner can prove itself.
 *
 * Usage:
 *   node tools/reimport.mjs scan                         # inventory only
 *   node tools/reimport.mjs dryrun --count 5             # run vision on 5 files, no DB
 *   node tools/reimport.mjs run --target dev --wipe      # full re-import to dev DB
 *   node tools/reimport.mjs replicate --from prod --to stage   # pg_dump | psql
 */
import { readFile, writeFile, readdir, stat, rename, mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import postgres from 'postgres';

// ── .env loader (no dependency) ───────────────────────────────────────────
const envPath = path.join(import.meta.dirname, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/i);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-5';
const SOURCE_ROOT = process.env.SOURCE_ROOT ?? '\\\\KADAUKESERVER\\Aufnahmen\\receipts';

// Subdirs that contain receipts we want to process.
// "out" is what the workflow uses as already-processed staging area — also valid.
const SCAN_DIRS = ['', 'in', 'out', 'photos', 'probablyWrong'];
// Subdirs that contain dupes/copies — ignore.
const SKIP_DIR_PATTERNS = [/copy/i, /backup/i];

const QUARANTINE_DIR = 'reimport-quarantine';
const STATE_FILE = path.join(import.meta.dirname, 'reimport-state.json');

// ── CLI parsing ───────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const cmd = args[0];
const flags = {};
for (let i = 1; i < args.length; i++) {
  const arg = args[i];
  if (arg.startsWith('--')) {
    const key = arg.slice(2);
    const next = args[i + 1];
    if (next && !next.startsWith('--')) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────
function normKette(name) {
  return String(name ?? 'UNBEKANNT')
    .toUpperCase()
    .replace(/Ä/g, 'AE').replace(/Ö/g, 'OE').replace(/Ü/g, 'UE').replace(/ẞ/g, 'SS').replace(/ß/g, 'SS')
    .replace(/\s+/g, '_')
    .replace(/[^A-Z0-9_]/g, '');
}

function pad(n) { return String(n).padStart(2, '0'); }

function formatDateTime(datum, uhrzeit) {
  const d = datum.replace(/[^0-9-]/g, '');
  const t = (uhrzeit ?? '00:00:00').replace(/[^0-9:]/g, '').replace(/:/g, '');
  return `${d}_${t.padEnd(6, '0').slice(0, 6)}`;
}

function isAlreadyNamed(filename) {
  // Pattern: KETTE_YYYY-MM-DD_HHMMSS_..jpg
  return /^[A-Z0-9_]+_\d{4}-\d{2}-\d{2}_\d{6}_.+\.jpe?g$/i.test(filename);
}

async function loadState() {
  try {
    return JSON.parse(await readFile(STATE_FILE, 'utf8'));
  } catch {
    return { processed: {}, failed: {} };
  }
}

async function saveState(state) {
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

// ── File discovery ────────────────────────────────────────────────────────
async function scanAll() {
  const files = [];
  for (const sub of SCAN_DIRS) {
    const dir = sub ? path.join(SOURCE_ROOT, sub) : SOURCE_ROOT;
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.isFile() && /\.(jpe?g|png)$/i.test(e.name)) {
          files.push({
            absPath: path.join(dir, e.name),
            subdir: sub,
            filename: e.name,
            alreadyNamed: isAlreadyNamed(e.name),
          });
        }
      }
    } catch (err) {
      console.warn(`[scan] skipped ${dir}: ${err.message}`);
    }
  }
  return files;
}

// ── Claude Vision call ────────────────────────────────────────────────────
const VISION_SYSTEM = `Du bist ein Datenextraktions-Assistent für deutsche Kassenbons.
Antworte AUSSCHLIESSLICH mit gültigem JSON ohne Markdown-Fence, ohne Kommentare.

Aus dem Bild extrahieren:
- Ladenkette (kurz, z.B. "LIDL", "EDEKA", "ALDI Süd", "DM-drogerie", "Bauhaus", "C&A")
- Filiale Adresse falls erkennbar
- Datum (YYYY-MM-DD)
- Uhrzeit falls auf Bon (HH:MM:SS)
- Gesamtbetrag in Euro als Zahl
- Alle Artikel mit:
  * original_text: was wörtlich auf dem Bon steht (mit Abkürzungen)
  * name: ausgeschriebene Version
  * ai_guess: deine beste Vermutung des Produkts (z.B. "Hafermilch", "Vollkornbrot")
  * menge: Zahl falls erkennbar (sonst null)
  * einheit: "kg" | "l" | "ml" | "g" | "stk" | "" (leer wenn unklar)
  * preis: Euro als Zahl, Komma → Punkt
  * kategorie: grobe Kategorie ("Obst", "Backwaren", "Drogerie", "Pfand", ...)

Regeln:
- PFAND-Zeilen als eigene Artikel mit kategorie="Pfand"
- Coupon-Rabatte zwischen Artikeln ignorieren, nicht als Artikel listen
- Bei verwackelten/unlesbaren/Nicht-Bon-Bildern: confidence < 0.3, leere artikel
- Bei guter Lesbarkeit: confidence 0.85-1.0

JSON-Schema:
{"confidence": 0.0-1.0, "ladenkette": "...", "filiale": "..." | null, "datum": "YYYY-MM-DD", "uhrzeit": "HH:MM:SS" | null, "gesamt_betrag": 12.34, "artikel": [...]}`;

async function visionExtract(absPath) {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');
  const buf = await readFile(absPath);
  const b64 = buf.toString('base64');
  const mediaType = /\.png$/i.test(absPath) ? 'image/png' : 'image/jpeg';

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 4096,
      system: VISION_SYSTEM,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: b64 } },
          { type: 'text', text: 'Extrahiere die Bon-Daten als JSON.' },
        ],
      }],
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = data.content?.[0]?.text ?? '';
  return { raw: text, usage: data.usage };
}

function parseLlmJson(raw) {
  const trimmed = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(trimmed); } catch { /* fall through */ }
  const start = trimmed.search(/[{]/);
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error(`no JSON found in: ${raw.slice(0, 200)}`);
  return JSON.parse(trimmed.slice(start, end + 1));
}

// ── DB operations ────────────────────────────────────────────────────────
function dbUrlFor(target) {
  if (target === 'dev') return process.env.DATABASE_URL_DEV;
  if (target === 'stage' || target === 'staging') return process.env.DATABASE_URL_STAGING;
  if (target === 'prod' || target === 'production') return process.env.DATABASE_URL_PROD;
  throw new Error(`unknown target: ${target}`);
}

async function wipe(sql) {
  // Wipe in dependency order; silently skip tables that don't exist yet
  // (a dev container on an older image may not have migration 005's canonical_meta).
  const tables = [
    'artikel_consumer', 'canonical_consumer', 'canonical_translation',
    'canonical_meta', 'einkaufsliste', 'vorrat_status',
    'verifikations_queue', 'artikel', 'einkauf',
  ];
  for (const t of tables) {
    try {
      await sql.unsafe(`TRUNCATE TABLE ${t} RESTART IDENTITY CASCADE`);
      console.log(`  truncated ${t}`);
    } catch (err) {
      console.warn(`  skipped ${t}: ${err.message.split('\n')[0]}`);
    }
  }
}

async function insertReceipt(sql, parsed, bildPfad, sourceFile) {
  const datum = parsed.datum;
  const ladenName = parsed.filiale ? `${parsed.ladenkette} ${parsed.filiale}` : parsed.ladenkette;
  const gesamt = Number.isFinite(parsed.gesamt_betrag) ? parsed.gesamt_betrag : null;

  // ensure filiale row (so the n8n workflow continues to work)
  let filialeId = null;
  if (parsed.ladenkette) {
    // canonical kette name (uppercase, no spaces)
    const ketteKey = String(parsed.ladenkette).trim();
    let kette = await sql`SELECT id FROM ladenkette WHERE LOWER(name) = LOWER(${ketteKey})`;
    if (!kette.length) {
      kette = await sql`INSERT INTO ladenkette (name) VALUES (${ketteKey}) RETURNING id`;
    }
    const ketteId = kette[0].id;
    const filialeName = parsed.filiale ?? parsed.ladenkette;
    let filiale = await sql`
      SELECT id FROM filiale WHERE ladenkette_id = ${ketteId} AND LOWER(name) = LOWER(${filialeName})
    `;
    if (!filiale.length) {
      filiale = await sql`
        INSERT INTO filiale (ladenkette_id, name) VALUES (${ketteId}, ${filialeName}) RETURNING id
      `;
    }
    filialeId = filiale[0].id;
  }

  const [einkauf] = await sql`
    INSERT INTO einkauf (datum, filiale_id, gesamt_betrag, telegram_user, roh_ladenname, bild_pfad)
    VALUES (${datum}, ${filialeId}, ${gesamt}, ${'reimport-claude'}, ${ladenName}, ${bildPfad})
    RETURNING id
  `;

  for (const a of parsed.artikel ?? []) {
    await sql`
      INSERT INTO artikel
        (einkauf_id, name, menge, einheit, preis, kategorie, original_text, ai_guess, canonical_name)
      VALUES
        (${einkauf.id}, ${a.name ?? a.original_text ?? ''}, ${a.menge ?? null}, ${a.einheit ?? ''},
         ${a.preis ?? null}, ${a.kategorie ?? ''}, ${a.original_text ?? a.name ?? ''},
         ${a.ai_guess ?? a.name ?? ''}, NULL)
    `;
  }
  return einkauf.id;
}

// ── Schema bootstrap (filiale + ladenkette since they aren't in 001_init) ─
async function ensureLegacyTables(sql) {
  await sql`CREATE TABLE IF NOT EXISTS ladenkette (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE
  )`;
  await sql`CREATE TABLE IF NOT EXISTS filiale (
    id SERIAL PRIMARY KEY,
    ladenkette_id INT REFERENCES ladenkette(id),
    name TEXT NOT NULL,
    UNIQUE (ladenkette_id, name)
  )`;
}

// ── Commands ──────────────────────────────────────────────────────────────
async function cmdScan() {
  const files = await scanAll();
  console.log(`Total: ${files.length} image files`);
  const bySub = {};
  for (const f of files) {
    const k = f.subdir || '(root)';
    bySub[k] = bySub[k] ?? { total: 0, named: 0 };
    bySub[k].total++;
    if (f.alreadyNamed) bySub[k].named++;
  }
  for (const [sub, c] of Object.entries(bySub)) {
    console.log(`  ${sub.padEnd(20)} ${c.total} files (${c.named} already-named)`);
  }
}

async function cmdDryrun() {
  const limit = parseInt(flags.count ?? '5', 10);
  const files = await scanAll();
  // Prefer photos/ files (the messy ones) for dryrun
  const sample = files
    .filter(f => f.subdir === 'photos')
    .sort(() => Math.random() - 0.5)
    .slice(0, limit);

  console.log(`Dry-run on ${sample.length} files from /photos/`);
  for (const f of sample) {
    console.log(`\n── ${f.filename} ───────────────────────`);
    try {
      const { raw, usage } = await visionExtract(f.absPath);
      const parsed = parseLlmJson(raw);
      console.log(`  confidence: ${parsed.confidence}`);
      console.log(`  ladenkette: ${parsed.ladenkette}`);
      console.log(`  datum:      ${parsed.datum}`);
      console.log(`  gesamt:     ${parsed.gesamt_betrag} €`);
      console.log(`  artikel:    ${parsed.artikel?.length ?? 0} items`);
      if (parsed.artikel?.length) {
        console.log('  first 3:');
        for (const a of parsed.artikel.slice(0, 3)) {
          console.log(`    - ${a.original_text} → ${a.ai_guess} (${a.preis} €)`);
        }
      }
      console.log(`  tokens: in=${usage.input_tokens} out=${usage.output_tokens}`);
    } catch (err) {
      console.error(`  ❌ ${err.message}`);
    }
  }
}

async function cmdRun() {
  const target = flags.target ?? 'dev';
  if (target !== 'dev' && !flags['allow-non-dev']) {
    throw new Error(`Refusing to write to ${target} without --allow-non-dev safety flag`);
  }
  const dbUrl = dbUrlFor(target);
  if (!dbUrl || dbUrl.includes('PASSWORD')) throw new Error(`DATABASE_URL_${target.toUpperCase()} not set in tools/.env`);
  const sql = postgres(dbUrl, { onnotice: () => {} });

  await ensureLegacyTables(sql);
  if (flags.wipe) {
    console.log(`Wiping ${target}...`);
    await wipe(sql);
  }

  const files = await scanAll();
  const state = await loadState();

  // Optional --max throttle for testing
  const max = flags.max ? parseInt(flags.max, 10) : Infinity;
  let processed = 0, failed = 0, skipped = 0, lowConfidence = 0;

  for (const f of files) {
    if (processed + failed >= max) break;
    if (state.processed[f.absPath]) { skipped++; continue; }

    process.stdout.write(`[${processed + failed + 1}/${files.length}] ${f.filename}... `);
    try {
      const { raw, usage } = await visionExtract(f.absPath);
      const parsed = parseLlmJson(raw);

      if (parsed.confidence < 0.5 || !parsed.datum || !parsed.ladenkette) {
        lowConfidence++;
        await moveToQuarantine(f, parsed);
        state.failed[f.absPath] = { reason: 'low-confidence', parsed, when: new Date().toISOString() };
        await saveState(state);
        console.log(`⚠ low confidence (${parsed.confidence})`);
        continue;
      }

      // Generate canonical bild_pfad
      const kette = normKette(parsed.ladenkette);
      const dt = formatDateTime(parsed.datum, parsed.uhrzeit);
      const baseName = f.filename.replace(/^[A-Z0-9_]+_\d{4}-\d{2}-\d{2}_\d{6}_/, '');
      const newName = `${kette}_${dt}_${baseName}`;
      // Use absolute URL so stage/dev (which don't have NPM in path) can load images
      // from prod's NPM. Prod itself works fine with absolute URL too.
      const bildPfad = `https://vds.giziko.online/receipts/${newName}`;

      const einkaufId = await insertReceipt(sql, parsed, bildPfad, f.absPath);
      const newPath = path.join(SOURCE_ROOT, newName);
      if (path.resolve(f.absPath) !== path.resolve(newPath)) {
        try { await rename(f.absPath, newPath); } catch { /* keep going */ }
      }

      state.processed[f.absPath] = { einkaufId, newName, when: new Date().toISOString(), tokens: usage };
      await saveState(state);
      processed++;
      console.log(`✓ einkauf #${einkaufId} (${parsed.artikel.length} items, ${usage.input_tokens}+${usage.output_tokens} tok)`);
    } catch (err) {
      failed++;
      state.failed[f.absPath] = { reason: err.message, when: new Date().toISOString() };
      await saveState(state);
      console.log(`✗ ${err.message.slice(0, 80)}`);
    }
  }

  await sql.end();
  console.log(`\nDone: ${processed} processed · ${skipped} skipped (already done) · ${failed} failed · ${lowConfidence} quarantined`);
}

async function moveToQuarantine(f, parsed) {
  const quarDir = path.join(SOURCE_ROOT, QUARANTINE_DIR);
  try { await mkdir(quarDir, { recursive: true }); } catch { /* exists */ }
  const newPath = path.join(quarDir, f.filename);
  if (path.resolve(f.absPath) !== path.resolve(newPath)) {
    try { await rename(f.absPath, newPath); } catch { /* keep going */ }
  }
  try {
    await writeFile(`${newPath}.claude.json`, JSON.stringify(parsed, null, 2));
  } catch { /* keep going */ }
}

// ── Main ──────────────────────────────────────────────────────────────────
const COMMANDS = { scan: cmdScan, dryrun: cmdDryrun, run: cmdRun };
const fn = COMMANDS[cmd];
if (!fn) {
  console.error(`Usage: node tools/reimport.mjs <scan|dryrun|run> [flags]\n` +
                `  scan                                 list files only\n` +
                `  dryrun [--count N]                   vision on N files, no DB\n` +
                `  run --target dev --wipe [--max N]    full re-import\n`);
  process.exit(1);
}
fn().catch(err => { console.error('FATAL:', err); process.exit(1); });
