import sql from '../db.js';

/** Normalise a merchant/biller string for fuzzy comparison and as the learning key. */
export const normMerchant = (s: string | null | undefined): string =>
  (s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9äöüß ]/gi, ' ').replace(/\s+/g, ' ').trim();

// Generic invoice/mail/file words — an OCR-less receipt keeps its e-mail subject / filename
// as roh_ladenname, so we must NOT learn from a key made only of these (else two unrelated
// "Rechnung" invoices would poison each other's account).
const GENERIC_TOKENS = new Set(['rechnung', 'rechnungen', 'invoice', 'invoices', 'receipt', 'beleg', 'belege', 'quittung', 'bestellung', 'bestellbestaetigung', 'order', 'auftrag', 'zahlung', 'payment', 'mahnung', 'gutschrift', 'pdf', 'dokument', 'document', 'vertrag', 'ihre', 'ihr', 'deine', 'dein', 'online', 'kunde', 'kundennummer', 'nummer', 'vom', 'fuer', 'fwd', 'aw', 're', 'wg', 'mail', 'email', 'scan', 'foto', 'img', 'image', 'file', 'datei', 'kopie']);

/** A biller string distinctive enough to key a learned account on: at least one token that
 *  is not a generic invoice/mail word. */
export const isLearnableMerchant = (merchant: string | null | undefined): boolean =>
  normMerchant(merchant).split(' ').filter(t => t.length >= 3 && !GENERIC_TOKENS.has(t)).join('').length >= 4;

/** Remember that invoices from this biller are paid from this account, so future invoices
 *  from the same biller default there. No-op for a generic/too-weak biller key. */
export async function learnMerchantKonto(merchant: string | null | undefined, kontoId: number | null): Promise<void> {
  if (kontoId == null || !isLearnableMerchant(merchant)) return;
  await sql`
    INSERT INTO merchant_konto (merchant_key, konto_id, updated_at) VALUES (${normMerchant(merchant)}, ${kontoId}, NOW())
    ON CONFLICT (merchant_key) DO UPDATE SET konto_id = EXCLUDED.konto_id, updated_at = NOW()`;
}

/** The learned account for a biller, or null. */
export async function learnedKontoFor(merchant: string | null | undefined): Promise<number | null> {
  if (!isLearnableMerchant(merchant)) return null;
  const [row] = await sql`SELECT konto_id FROM merchant_konto WHERE merchant_key = ${normMerchant(merchant)}`;
  return row ? (row.konto_id as number) : null;
}

/** Canonicalise an invoice against the bank statement that paid it: marry them (only if the
 *  invoice has no bank yet); then — ONLY if this statement is now the receipt's PRIMARY
 *  payment (not a cross-account split-shipment sibling) — move the invoice onto that
 *  statement's account (the account that actually paid it) and learn biller -> account. */
export async function alignInvoiceToBank(einkaufId: number, bankTxId: number, bankKontoId: number | null): Promise<void> {
  await sql`UPDATE einkauf SET bank_tx_id = COALESCE(bank_tx_id, ${bankTxId}) WHERE id = ${einkaufId}`;
  const [e] = await sql`SELECT roh_ladenname, bank_tx_id FROM einkauf WHERE id = ${einkaufId}`;
  if (!e || e.bank_tx_id !== bankTxId) return;   // linked as a sibling → don't move konto / learn
  await sql`UPDATE einkauf SET konto_id = ${bankKontoId} WHERE id = ${einkaufId}`;
  await learnMerchantKonto(e.roh_ladenname as string | null, bankKontoId);
}

/** After an invoice's merchant is known (post-OCR) and BEFORE it's reconciled, move it onto
 *  the learned account for that biller, if any. Never touches an already-reconciled receipt. */
export async function applyLearnedKonto(einkaufId: number): Promise<void> {
  const [e] = await sql`SELECT roh_ladenname, konto_id, bank_tx_id FROM einkauf WHERE id = ${einkaufId}`;
  if (!e || e.bank_tx_id != null) return;
  const learned = await learnedKontoFor(e.roh_ladenname as string | null);
  if (learned != null && learned !== e.konto_id) await sql`UPDATE einkauf SET konto_id = ${learned} WHERE id = ${einkaufId}`;
}
