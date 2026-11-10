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

/* ─────────────────────────────────────────────────────────────────────────────────────────────
 * Return ANNOUNCEMENTS — "I started a return", before any money has moved.
 *
 * Amazon sends up to three mails per return: "Ihre Rücksendung von X" (request confirmed, with the
 * order number, the item, the ESTIMATED refund and a drop-off deadline), "Abgabebestätigung für Ihre
 * Rücksendung von X" (dropped off), and "Ihre Erstattung für X" (money issued). Martin wants VDS to
 * know about a return from the first mail on (2026-11-10). Two things follow from that:
 *
 *   1. An announcement must NEVER fall through to the receipt parser. It contains a total ("Geschätzte
 *      Gesamtsumme der Rückerstattung 98,10 €") and, if the model calls it "none" because no money has
 *      flowed yet, the normal import would happily book it as a POSITIVE 98,10 € purchase.
 *   2. The later refund mail for the same return must not become a SECOND suggestion — confirming both
 *      would book the return twice. `decideReturnLink` pairs them by order number + item.
 * ──────────────────────────────────────────────────────────────────────────────────────────── */

export interface ReturnAnnouncement {
  isAnnouncement: boolean;
  /** Drop-off deadline exactly as the mail words it ("10. November 2026"), when it names one. */
  deadline: string | null;
}

// The money has actually moved — such a mail is a refund, whatever else it also says. Checked FIRST:
// Amazon's "Ihre Erstattung für DREO …" of 2026-08-03 carries drop-off wording in its body too.
const REFUND_DONE: RegExp[] = [
  /^\s*(ihre\s+erstattung\s+f[üu]r|your\s+refund\s+(for|on))\b/i,
  /\b(gutschriftbest[äa]tigung|refund\s+on\s+order)\b/i,
  /\berstattung\s+wurde\s+veranlasst\b/i,
  /\bhas\s+been\s+refunded\b/i,
  /\bwe('| ha)ve\s+(issued|processed)\b[^.\n]{0,20}\brefund\b/i,
];
const ANNOUNCED: RegExp[] = [
  /^\s*(ihre\s+r[üu]cksendung\s+von|your\s+return\s+of)\b/i,
  /^\s*abgabebest[äa]tigung\s+f[üu]r\s+ihre\s+r[üu]cksendung\b/i,
  /\br[üu]ckgabeanfrage\s+wurde\s+best[äa]tigt\b/i,
  /\breturn\s+request\s+is\s+confirmed\b/i,
  /\br[üu]cksendung\s+wurde\s+(abgelegt|angemeldet)\b/i,
];

export function detectReturnAnnouncement(subject: string | null | undefined, body: string | null | undefined): ReturnAnnouncement {
  const subj = (subject ?? '').slice(0, 400);
  const text = (subj + '\n' + (body ?? '')).slice(0, 20000);
  if (REFUND_DONE.some(re => re.test(subj) || re.test(text))) return { isAnnouncement: false, deadline: null };
  if (!ANNOUNCED.some(re => re.test(subj) || re.test(text))) return { isAnnouncement: false, deadline: null };
  const m = text.match(/\br[üu]ckgabe\s+bis:?\s*(\d{1,2}\.\s*[A-Za-zÄÖÜäöü]+\.?\s*\d{4})/i)
    ?? text.match(/\b(?:ablegen|abgeben|drop\s+off)[^.\n]{0,40}?\bbis\s+zum\s+([A-Za-z]{3,9}\.?\s*\d{1,2})\b/i)
    ?? text.match(/\bbis\s+zum\s+([A-Za-z]{3,9}\.?\s*\d{1,2})\s+ablegen\b/i)
    ?? text.match(/\bdrop\s+off\b[^.\n]{0,30}?\bby\s+([A-Za-z]{3,9}\.?\s*\d{1,2})\b/i);
  return { isAnnouncement: true, deadline: m ? m[1].replace(/\s+/g, ' ').trim() : null };
}

/** One earlier refund mail of the same user and the same order number. */
export interface ReturnLinkCandidate {
  ledgerId: number;
  status: string;            // imported_email.status: 'refund_suggested' (open) or 'refund' (booked)
  einkaufId: number | null;  // the receipt the refund was booked against, once booked
  isAnnouncement: boolean;
  item: string | null;
  amount: number | null;
}

export type ReturnLinkDecision =
  | { action: 'store' }
  | { action: 'store_and_supersede'; supersedeLedgerId: number; reason: string }
  | { action: 'skip'; reason: string };

const normItem = (s: string | null | undefined): string =>
  (s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

/** Same product? Amazon cuts titles at different lengths ("oliso M3Pro..." vs. the model's
 *  "oliso M3Pro Vakuumierer"), so one name being a prefix of the other counts, and so does an
 *  identical first word of 4+ characters. An empty name only matches when the order has exactly
 *  ONE candidate — with two returns from one order, guessing would pair the wrong ones. */
export function sameReturnItem(a: string | null | undefined, b: string | null | undefined, onlyCandidate: boolean): boolean {
  const x = normItem(a), y = normItem(b);
  if (!x || !y) return onlyCandidate;
  if (x.startsWith(y) || y.startsWith(x)) return Math.min(x.length, y.length) >= 6 || x === y;
  const fx = x.split(' ')[0], fy = y.split(' ')[0];
  return fx.length >= 4 && fx === fy;
}

const euro = (n: number | null) => (n != null && n > 0 ? n.toFixed(2).replace('.', ',') + ' €' : null);

/**
 * What to do with a NEW refund-ish mail, given the earlier ones for the same order. Pure — the
 * caller loads the candidates and applies the decision. Only an ANNOUNCEMENT is ever linked: two
 * genuine refunds on one order (a return plus a later price-guarantee credit) stay independent,
 * exactly as before this existed.
 */
export function decideReturnLink(
  incoming: { isAnnouncement: boolean; item: string | null; amount: number | null },
  candidates: ReturnLinkCandidate[],
): ReturnLinkDecision {
  const pool = candidates.filter(c => c.status === 'refund_suggested' || c.status === 'refund');
  const match = (c: ReturnLinkCandidate) => sameReturnItem(incoming.item, c.item, pool.length === 1);

  if (incoming.isAnnouncement) {
    // A refund for this return is already known → the announcement adds nothing.
    const refund = pool.find(c => !c.isAnnouncement && match(c));
    if (refund) return { action: 'skip', reason: 'Rücksende-Anmeldung zu einer Erstattung, die schon vorliegt' + (refund.einkaufId ? ` (Beleg #${refund.einkaufId})` : '') };
    // Amazon re-sends the announcement when the return method changes → keep the first one.
    const twin = pool.find(c => c.isAnnouncement && match(c));
    if (twin) return { action: 'skip', reason: 'Rücksendung schon angemeldet' + (twin.einkaufId ? ` und verbucht (Beleg #${twin.einkaufId})` : '') };
    return { action: 'store' };
  }

  const ann = pool.find(c => c.isAnnouncement && match(c));
  if (!ann) return { action: 'store' };
  if (ann.status === 'refund') {
    const now = euro(incoming.amount), then = euro(ann.amount);
    const diff = now && then && now !== then ? ` Laut Erstattungsmail ${now} statt ${then} — bitte den Betrag am Beleg prüfen.` : '';
    return { action: 'skip', reason: `Rücksendung wurde schon über die Anmeldung verbucht${ann.einkaufId ? ` (Beleg #${ann.einkaufId})` : ''}.${diff}` };
  }
  // Still open: the refund mail carries the real amount, so it replaces the announcement.
  return { action: 'store_and_supersede', supersedeLedgerId: ann.ledgerId, reason: 'Abgelöst durch die Erstattungsmail' + (euro(incoming.amount) ? ` (${euro(incoming.amount)})` : '') };
}
