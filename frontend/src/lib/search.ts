// Google-style search operators for client-side (in-memory) filters.
// Mirrors the backend grammar (backend/src/lib/search.ts):
//   foo bar    → AND      foo, bar → OR
//   -foo       → exclude  "foo bar" → exact phrase
// Matching is substring, case- AND accent-insensitive ("apfel" → "Äpfel").
// Field/numeric qualifiers are backend-only; here unknown `key:val` tokens are
// treated as plain text, which is harmless for local list filtering.

interface Term { text: string }
interface Parsed { orGroups: Term[][]; excludes: Term[] }

/** Strip diacritics + lowercase so "Äpfel" and "apfel" compare equal. */
function fold(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function tokenize(raw: string): { v: string; comma: boolean }[] {
  const out: { v: string; comma: boolean }[] = [];
  let i = 0;
  while (i < raw.length) {
    const c = raw[i];
    if (c === ',') { out.push({ v: '', comma: true }); i++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    let buf = '';
    while (i < raw.length) {
      const ch = raw[i];
      if (ch === '"') {
        i++;
        while (i < raw.length && raw[i] !== '"') { buf += raw[i]; i++; }
        if (i < raw.length) i++;
        continue;
      }
      if (ch === ',' || /\s/.test(ch)) break;
      buf += ch;
      i++;
    }
    out.push({ v: buf, comma: false });
  }
  return out;
}

export function parseSearch(raw: string): Parsed {
  const orGroups: Term[][] = [];
  const excludes: Term[] = [];
  let group: Term[] = [];
  const flush = () => { if (group.length) { orGroups.push(group); group = []; } };

  for (const tk of tokenize(raw)) {
    if (tk.comma) { flush(); continue; }
    const s = tk.v;
    if (!s) continue;
    if (s.startsWith('-') && s.length > 1) { excludes.push({ text: s.slice(1) }); continue; }
    group.push({ text: s });
  }
  flush();
  return { orGroups, excludes };
}

/** True if the haystacks satisfy the query. Empty query matches everything. */
export function searchMatch(raw: string, haystacks: (string | null | undefined)[]): boolean {
  const p = parseSearch((raw ?? '').trim());
  if (!p.orGroups.length && !p.excludes.length) return true;
  const hay = haystacks.filter(Boolean).map(h => fold(h as string));
  const has = (term: string) => { const t = fold(term); return hay.some(h => h.includes(t)); };
  const groupOk = !p.orGroups.length || p.orGroups.some(g => g.every(t => has(t.text)));
  const exclOk = p.excludes.every(t => !has(t.text));
  return groupOk && exclOk;
}
