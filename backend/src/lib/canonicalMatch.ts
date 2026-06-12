// Deterministic canonical-name matching against the existing list, so freshly
// scanned receipts reliably inherit known canonical names without depending on
// a (non-deterministic) LLM. Whole-word, accent/case-insensitive containment:
//   "Bio Quetschie"  → "Quetschie"     (whole word present)
//   "Gurken St"      → "Gurken"
//   "Apfelsaft"      ↛ "Apfel"          (not a whole word → no false match)

function fold(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Longest (most specific) existing canonical name that appears as a whole
 *  word/phrase in any of the item's texts, or null. */
export function matchExistingCanonical(
  texts: (string | null | undefined)[],
  existing: string[],
): string | null {
  const hay = ' ' + texts.filter(Boolean).map(s => fold(s as string)).join('  ') + ' ';
  let best: string | null = null;
  let bestLen = 0;
  for (const c of existing) {
    const cf = fold(c).trim();
    if (cf.length < 3) continue; // too short → too risky
    const re = new RegExp(`(?:^|[^0-9a-zäöüß])${escapeRe(cf)}(?:$|[^0-9a-zäöüß])`);
    if (cf.length > bestLen && re.test(hay)) { best = c; bestLen = cf.length; }
  }
  return best;
}
