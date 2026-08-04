/**
 * refundHeuristic — a CHEAP, dependency-free classifier that decides whether an
 * incoming e-mail is likely a refund / return / cancellation / price-adjustment
 * notice. It runs in the IMAP importer BEFORE the LLM extraction, so a refund mail
 * is intercepted (status 'refund_suggested') instead of being either silently
 * skipped or mis-parsed into a bogus POSITIVE receipt.
 *
 * Design stance: SURFACE-ONLY. A hit never books money — it only flags the mail for
 * the user to review + confirm. So the cost of a false NEGATIVE is just "stays
 * skipped as today", and the cost of a false POSITIVE is one dismissible "prüfen"
 * entry. We therefore lean slightly toward recall on decisive terms but gate the
 * ambiguous ones behind corroboration + veto checks.
 *
 * Rules (evaluated in order):
 *   1. STRONG term (subject or body) OR a COMPLETION phrase  → refund. These strings
 *      essentially never appear in a non-refund mail.
 *   2. only a WEAK term  → refund ONLY IF corroborated (a money amount or an order
 *      reference is present) AND no hard veto fired.
 *   3. otherwise → not a refund.
 *
 * Vetoes catch the classic traps: the Widerrufsbelehrung legal footer present in
 * EVERY order confirmation, "kostenloser Rückversand"/"free returns" selling points,
 * Gutschein/voucher marketing (note: `gutschrift`≠`gutschein`, distinct words),
 * money-back-GUARANTEE ads, newsletter unsubscribes, price-drop marketing, and
 * Rücklastschrift/chargebacks (opposite sign).
 */

export interface RefundVerdict {
  isRefund: boolean;
  score: number;
  reasons: string[]; // human-readable term hits, for the import-log note
  veto?: string; // set when a would-be weak match was suppressed
}

// Decisive: German + English + confirmed cancellations. Word-bounded so `gutschrift`
// can never substring-hit `gutschein`.
const STRONG: Array<[RegExp, string]> = [
  [/\berstattung(en|s\w*)?\b/i, 'Erstattung'],
  [/\br[üu]ckerstattung(en)?\b/i, 'Rückerstattung'],
  [/\br[üu]ckzahlung(en)?\b/i, 'Rückzahlung'],
  [/\bgutschrift(en|sanzeige)?\b/i, 'Gutschrift'],
  [/\b(storno|korrektur)rechnung\b/i, 'Stornorechnung'],
  [/\brefund(ed|s|ing)?\b/i, 'refund'],
  [/\bcredit\s+(note|memo)\b/i, 'credit note'],
  [/\breimburse(d|ment|s)?\b/i, 'reimbursement'],
  [/\bbestellung\b[^.\n]{0,40}\bstorniert\b/i, 'Bestellung storniert'],
  [/\border\b[^.\n]{0,40}\b(cancell?ed|refunded)\b/i, 'order cancelled/refunded'],
];

// Action/completion phrasings — as decisive as STRONG (they describe a refund that
// already happened), and they give us the amount to pre-fill.
const COMPLETION: Array<[RegExp, string]> = [
  [/\b(wurde|wird|haben\s+wir)\b[^.\n]{0,30}\berstattet\b/i, 'wurde erstattet'],
  [/\berstattung\b[^.\n]{0,20}\b(veranlasst|erfolgt|abgeschlossen|in\s+h[öo]he)\b/i, 'Erstattung veranlasst'],
  [/\bbetrag\b[^.\n]{0,25}\b(zur[üu]ck|erstattet|gutgeschrieben)\b/i, 'Betrag zurück'],
  [/\bgutgeschrieben\b/i, 'gutgeschrieben'],
  [/\br[üu]cksendung\b[^.\n]{0,30}\b(erhalten|eingegangen|bearbeitet)\b/i, 'Rücksendung erhalten'],
  [/\bretoure\b[^.\n]{0,30}\b(erhalten|eingegangen|bearbeitet|verarbeitet)\b/i, 'Retoure bearbeitet'],
  [/\bwe('| ha)ve\b[^.\n]{0,20}\b(issued|processed)\b[^.\n]{0,20}\brefund\b/i, "we've issued a refund"],
  [/\brefund(ed)?\b[^.\n]{0,25}\b(to your|of|has been|is on its way|payment method)\b/i, 'refunded to your …'],
  [/\bhas\s+been\s+refunded\b/i, 'has been refunded'],
  [/\bwe\s+(have\s+)?received\s+your\s+return\b/i, 'we received your return'],
  [/\byour\s+return\b[^.\n]{0,25}\b(received|processed|accepted)\b/i, 'return received/accepted'],
  [/\bwe('| ha)ve\s+credited\b/i, "we've credited"],
];

// Ambiguous on their own — need corroboration (money or order ref) and no veto.
const WEAK: Array<[RegExp, string]> = [
  [/\br[üu]cksendung\b/i, 'Rücksendung'],
  [/\bretoure\b/i, 'Retoure'],
  [/\bstornier(t|ung)\b/i, 'Stornierung'],
  [/\bwiderruf\b/i, 'Widerruf'],
  [/\br[üu]ckgabe\b/i, 'Rückgabe'],
  [/\bpreisnachlass\b/i, 'Preisnachlass'],
  [/\bdifferenzbetrag\b/i, 'Differenzbetrag'],
  [/\breturn(ed|s)?\b/i, 'return'],
  [/\bcancell?ation\b/i, 'cancellation'],
  [/\bprice\s+(adjustment|drop)\b/i, 'price adjustment'],
  [/\bmoney\s*back\b/i, 'money back'],
  [/\bstore\s+credit\b/i, 'store credit'],
];

// Hard vetoes: if only a WEAK term matched, these suppress it. (A STRONG/COMPLETION
// hit is decisive and ignores vetoes — a real "Erstattung veranlasst" beats a
// "kostenloser Rückversand" footer in the same mail.)
const VETO: Array<[RegExp, string]> = [
  [/\bwiderrufs(belehrung|recht|formular)\b/i, 'Widerrufsbelehrung (Rechtstext)'],
  [/\bmuster-?widerrufsformular\b/i, 'Muster-Widerrufsformular'],
  [/\b(kostenlos\w*|gratis|inklusive|free)\b[^.\n]{0,20}\b(r[üu]ck(versand|sendung)|retoure|return(s)?(\s+shipping)?)\b/i, 'kostenloser Rückversand'],
  [/\bfree\s+returns?\b/i, 'free returns'],
  [/\bgutschein(e|code|s)?\b/i, 'Gutschein (Marketing)'],
  [/\b(rabattcode|discount\s+code|voucher|gift\s*card)\b/i, 'Rabattcode/Voucher'],
  [/\bgeld[- ]?zur[üu]ck[- ]?garantie\b/i, 'Geld-zurück-Garantie'],
  [/\bmoney[- ]?back\s+guarantee\b/i, 'money-back guarantee'],
  [/\b(newsletter\s+abbestellen|abmeldung\s+best[äa]tigt|unsubscribe|k[üu]ndigungsbest[äa]tigung|cancel\s+your\s+subscription)\b/i, 'Newsletter/Abo-Abmeldung'],
  [/\b(jederzeit\s+stornieren|cancel\s+anytime)\b/i, 'jederzeit stornieren (Werbung)'],
  [/\b(r[üu]cklastschrift|r[üu]ckbuchung|chargeback)\b/i, 'Rücklastschrift/Chargeback'],
  [/\b(r[üu]cksendung\s+anmelden|r[üu]cksendeetikett|start\s+a\s+return|return\s+label|how\s+to\s+return)\b/i, 'Rücksende-Anleitung'],
];

// A EUR amount like "89,99", "1.234,56", "€ 89,99", "89.99". Mirrors the importer's
// price-signal shape. Used only as corroboration, never to require an amount.
const MONEY = /(?:€|eur\b)?\s*\d{1,3}(?:[.\s]\d{3})*[.,]\d{2}\b/i;
// An order / reference number: "Bestellnummer 302-1234567", "order #123-456", "Auftrag 4711".
const ORDER_REF = /\b(bestell(nummer|ung)?|auftrags?(nummer)?|order|reference|ref)\b[^\n]{0,12}[#:]?\s*[A-Za-z0-9][A-Za-z0-9-]{4,}/i;

function hits(text: string, list: Array<[RegExp, string]>): string[] {
  const out: string[] = [];
  for (const [re, label] of list) if (re.test(text)) out.push(label);
  return out;
}

/**
 * Classify a mail. `subject` is weighted implicitly by also being concatenated into
 * the scanned text; both are lower-cased by the case-insensitive regexes.
 */
export function detectRefundMail(subject: string | null | undefined, body: string | null | undefined): RefundVerdict {
  const subj = (subject ?? '').slice(0, 400);
  const text = (subj + '\n' + (body ?? '')).slice(0, 20000);

  const strong = hits(text, STRONG);
  const subjStrong = hits(subj, STRONG); // subject-only strong hits never come from the body footer
  const completion = hits(text, COMPLETION);
  const money = MONEY.test(text);
  const orderRef = ORDER_REF.test(text);
  // The Widerrufsbelehrung / Muster-Widerrufsformular legal footer is present in nearly EVERY order
  // confirmation and its model text contains STRONG terms ("Rückzahlung", "Erstattung") as passive
  // boilerplate. So a body-only strong term is NOT decisive when that footer is present and there is
  // no action phrase — else the refund pre-check would fire on normal purchase mails and could hide
  // the real receipt. Subject strong terms + completion (action) phrases never come from the footer.
  const legalFooter = /\bwiderrufs(belehrung|recht|formular)\b|muster-?\s*widerrufsformular/i.test(text);

  // 1) decisive: an action phrase, or a strong term IN THE SUBJECT
  if (completion.length || subjStrong.length) {
    const reasons = [...strong, ...completion];
    if (money) reasons.push('Betrag erkannt');
    if (orderRef) reasons.push('Bestellnummer erkannt');
    const score = 3 * strong.length + 3 * completion.length + (money ? 1 : 0) + (orderRef ? 1 : 0);
    return { isRefund: true, score, reasons };
  }
  // 1b) a body-only strong term is decisive UNLESS it's just the Widerrufsbelehrung boilerplate.
  if (strong.length) {
    if (legalFooter) return { isRefund: false, score: 0, reasons: strong, veto: 'Widerrufsbelehrung (Rechtstext, keine Erstattungs-Aktion)' };
    const reasons = [...strong];
    if (money) reasons.push('Betrag erkannt');
    if (orderRef) reasons.push('Bestellnummer erkannt');
    return { isRefund: true, score: 3 * strong.length + (money ? 1 : 0) + (orderRef ? 1 : 0), reasons };
  }

  // 2) weak → needs corroboration and no veto
  const weak = hits(text, WEAK);
  if (weak.length) {
    const veto = hits(text, VETO);
    if (veto.length) return { isRefund: false, score: 0, reasons: weak, veto: veto[0] };
    if (money || orderRef) {
      const reasons = [...weak];
      if (money) reasons.push('Betrag erkannt');
      if (orderRef) reasons.push('Bestellnummer erkannt');
      return { isRefund: true, score: weak.length + (money ? 1 : 0) + (orderRef ? 1 : 0), reasons };
    }
    return { isRefund: false, score: 0, reasons: weak, veto: 'nicht bestätigt (kein Betrag/Bestellnummer)' };
  }

  // 3) nothing
  return { isRefund: false, score: 0, reasons: [] };
}
