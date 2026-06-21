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

// Common German modifiers / store-brand prefixes that don't change a product's
// identity — ignored when deciding whether a whole-word match is "clean".
const MODIFIERS = new Set([
  'bio', 'frisch', 'frische', 'mini', 'maxi', 'xxl', 'gross', 'gros', 'klein', 'fein', 'feine',
  'original', 'classic', 'neu', 'aktion', 'demeter', 'natur', 'naturland', 'vegan', 'laktosefrei',
  'glutenfrei', 'zarte', 'premium', 'deluxe', 'family', 'pack', 'stueck', 'packung', 'beutel',
  'rewe', 'edeka', 'aldi', 'lidl', 'penny', 'netto', 'kaufland', 'denns', 'alnatura',
]);

/** A whole-word canonical match that is SAFE to auto-apply: the canonical appears
 *  as a whole word AND the OCR text has no OTHER significant product noun beyond
 *  the canonical + known modifiers. Stops "dmBio Käse Tortellini" (a pasta) from
 *  silently inheriting the canonical "Käse", while still allowing "Bio Quetschie"
 *  → "Quetschie". Returns the match, or null when it is risky/absent — risky
 *  matches fall through to the AI + Prüfen review instead of auto-applying. */
export function cleanMatch(
  texts: (string | null | undefined)[],
  existing: string[],
): string | null {
  const match = matchExistingCanonical(texts, existing);
  if (!match) return null;
  const canonToks = new Set(fold(match).split(/[^0-9a-zäöüß]+/).filter(Boolean));
  const ocrToks = fold(texts.filter(Boolean).join(' ')).split(/[^0-9a-zäöüß]+/).filter(Boolean);
  const leftover = ocrToks.filter(tok =>
    tok.length >= 4 && /[a-zäöüß]/.test(tok) && !canonToks.has(tok) && !MODIFIERS.has(tok));
  return leftover.length ? null : match;
}
