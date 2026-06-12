// Google-style search operators, shared by every backend search endpoint.
//
// Grammar (decided with the user):
//   foo bar        → AND  (space-separated terms, all must match)
//   foo, bar       → OR   (comma separates alternative groups)
//   -foo           → exclude (NOT, applies to the whole query)
//   "foo bar"      → exact contiguous phrase
//   feld:wert      → field qualifier (laden:lidl, kategorie:obst …)
//   preis>2        → numeric filter (> < >= <= =)
//
// Matching is substring, case- AND accent-insensitive ("apfel" → "Äpfel")
// via the unaccent extension when available (detected at boot, graceful
// fallback to plain ILIKE otherwise).
import type { PendingQuery, Row } from 'postgres';
import sql from '../db.js';

/** A composable SQL fragment, as produced by sql`…`. */
export type Frag = PendingQuery<Row[]>;

/** A matcher turns a LIKE pattern into a boolean SQL fragment (one column,
 *  an EXISTS subquery, an OR over several columns — whatever the endpoint
 *  needs). */
export type Matcher = (pattern: string) => Frag;
/** A numeric comparator turns an operator+value into a boolean SQL fragment. */
export type NumCmp = (op: NumOp, value: number) => Frag;

type NumOp = '>' | '<' | '>=' | '<=' | '=';

export interface SearchConfig {
  /** Columns/subqueries the free-text terms search across (ORed together). */
  text: Matcher[];
  /** `feld:wert` qualifiers, keyed by the field name the user types. */
  fields?: Record<string, Matcher>;
  /** `feld>zahl` numeric filters, keyed by the field name the user types. */
  nums?: Record<string, NumCmp>;
}

// ── unaccent feature detection ────────────────────────────────────────────
let hasUnaccent = false;
/** Detect the unaccent extension once at boot. */
export async function initSearch(): Promise<void> {
  try {
    const [r] = await sql`SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname = 'unaccent') AS ok`;
    hasUnaccent = !!r?.ok;
  } catch {
    hasUnaccent = false;
  }
}

/** Escape LIKE wildcards so user input is matched literally. */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, m => '\\' + m);
}
/** Build a substring LIKE pattern for a term. */
export function pat(term: string): string {
  return `%${escapeLike(term)}%`;
}

/** Accent-aware, case-insensitive substring match of a column against a
 *  prebuilt LIKE pattern. */
export function lk(col: Frag, pattern: string): Frag {
  return hasUnaccent
    ? sql`unaccent(${col}) ILIKE unaccent(${pattern}) ESCAPE '\\'`
    : sql`${col} ILIKE ${pattern} ESCAPE '\\'`;
}

/** Matcher for a single column. */
export function col(c: Frag): Matcher {
  return p => lk(c, p);
}

/** Numeric comparator for a single column. */
export function numCol(c: Frag): NumCmp {
  return (op, v) => {
    switch (op) {
      case '>':  return sql`${c} > ${v}`;
      case '<':  return sql`${c} < ${v}`;
      case '>=': return sql`${c} >= ${v}`;
      case '<=': return sql`${c} <= ${v}`;
      default:   return sql`${c} = ${v}`;
    }
  };
}

// ── parser ─────────────────────────────────────────────────────────────────
interface Term { text: string }
interface ParsedQuery {
  orGroups: Term[][];
  excludes: Term[];
  fields: { key: string; value: string }[];
  nums: { key: string; op: NumOp; value: number }[];
}

interface RawToken { v: string; quoted: boolean; comma: boolean }

/** Split into tokens, honoring "quoted phrases" and treating commas as group
 *  separators. A quote anywhere in a token marks it as a contiguous phrase. */
function tokenize(raw: string): RawToken[] {
  const out: RawToken[] = [];
  let i = 0;
  while (i < raw.length) {
    const c = raw[i];
    if (c === ',') { out.push({ v: '', quoted: false, comma: true }); i++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    let buf = '';
    let quoted = false;
    while (i < raw.length) {
      const ch = raw[i];
      if (ch === '"') {
        quoted = true;
        i++;
        while (i < raw.length && raw[i] !== '"') { buf += raw[i]; i++; }
        if (i < raw.length) i++; // closing quote
        continue;
      }
      if (ch === ',' || /\s/.test(ch)) break;
      buf += ch;
      i++;
    }
    out.push({ v: buf, quoted, comma: false });
  }
  return out;
}

const NUM_RE = /^([a-zA-ZÀ-ſ]+)(>=|<=|>|<|=)(-?\d+(?:[.,]\d+)?)$/;

export function parseSearch(
  raw: string,
  opts?: { fields?: string[]; nums?: string[] },
): ParsedQuery {
  const fieldKeys = new Set((opts?.fields ?? []).map(s => s.toLowerCase()));
  const numKeys = new Set((opts?.nums ?? []).map(s => s.toLowerCase()));

  const orGroups: Term[][] = [];
  const excludes: Term[] = [];
  const fields: ParsedQuery['fields'] = [];
  const nums: ParsedQuery['nums'] = [];

  let group: Term[] = [];
  const flush = () => { if (group.length) { orGroups.push(group); group = []; } };

  for (const tk of tokenize(raw)) {
    if (tk.comma) { flush(); continue; }
    let s = tk.v;
    if (!s) continue;

    let neg = false;
    if (s.startsWith('-') && s.length > 1) { neg = true; s = s.slice(1); }

    // numeric filter: key>value (only for known numeric keys, never quoted)
    if (!tk.quoted) {
      const m = NUM_RE.exec(s);
      if (m && numKeys.has(m[1].toLowerCase())) {
        nums.push({ key: m[1].toLowerCase(), op: m[2] as NumOp, value: parseFloat(m[3].replace(',', '.')) });
        continue;
      }
    }

    // field qualifier: key:value (only for known field keys)
    const colon = s.indexOf(':');
    if (colon > 0) {
      const key = s.slice(0, colon).toLowerCase();
      const val = s.slice(colon + 1);
      if (fieldKeys.has(key) && val) { fields.push({ key, value: val }); continue; }
    }

    const term: Term = { text: s };
    if (neg) excludes.push(term);
    else group.push(term);
  }
  flush();

  return { orGroups, excludes, fields, nums };
}

// ── SQL compiler ────────────────────────────────────────────────────────────
function join(frags: Frag[], sep: 'AND' | 'OR'): Frag {
  return frags.reduce((acc, f, i) =>
    i === 0 ? f : (sep === 'AND' ? sql`${acc} AND ${f}` : sql`${acc} OR ${f}`));
}

/** True if a term matches ANY of the configured text matchers. */
function anyText(matchers: Matcher[], term: string): Frag {
  const p = pat(term);
  return sql`(${join(matchers.map(m => m(p)), 'OR')})`;
}

/** Compile a raw query string into an `AND (…)` WHERE fragment (or empty SQL
 *  when the query is blank), ready to drop into `WHERE TRUE ${…}`. */
export function searchFilter(raw: string, cfg: SearchConfig): Frag {
  const parsed = parseSearch((raw ?? '').trim(), {
    fields: Object.keys(cfg.fields ?? {}),
    nums: Object.keys(cfg.nums ?? {}),
  });

  const clauses: Frag[] = [];

  // positive: (group1 OR group2 …), each group = AND of its terms
  const groupFrags = parsed.orGroups
    .map(g => sql`(${join(g.map(t => anyText(cfg.text, t.text)), 'AND')})`);
  if (groupFrags.length) clauses.push(sql`(${join(groupFrags, 'OR')})`);

  // exclusions (global)
  for (const ex of parsed.excludes) clauses.push(sql`NOT ${anyText(cfg.text, ex.text)}`);

  // field qualifiers
  for (const f of parsed.fields) {
    const m = cfg.fields?.[f.key];
    if (m) clauses.push(m(pat(f.value)));
  }

  // numeric filters
  for (const n of parsed.nums) {
    const c = cfg.nums?.[n.key];
    if (c) clauses.push(c(n.op, n.value));
  }

  if (!clauses.length) return sql``;
  return sql`AND (${join(clauses, 'AND')})`;
}
