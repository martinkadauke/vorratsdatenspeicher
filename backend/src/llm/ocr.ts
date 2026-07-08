import { readFile } from 'node:fs/promises';
import { getConfig } from '../config.js';
import { parseLlmJson } from './ollama.js';
import { recordUsage } from './provider.js';

const VISION_SYSTEM = `Du bist ein Datenextraktions-Assistent für deutsche Kaufbelege — sowohl Kassenbons ALS AUCH Rechnungen und Bestellbestätigungen (z.B. von Online-Shops, Versorgern, Lieferdiensten; häufig als PDF).
Antworte AUSSCHLIESSLICH mit gültigem JSON ohne Markdown-Fence, ohne Kommentare.

Aus dem Bild ODER PDF extrahieren:
- Ladenkette/Händler (kurz, z.B. "LIDL", "EDEKA", "ALDI Süd", "DM-drogerie", "Amazon", "Zalando", "Telekom")
- Filiale/Adresse falls erkennbar (sonst null)
- Datum (YYYY-MM-DD) — Kauf-, Rechnungs- oder Bestelldatum
- Uhrzeit falls vorhanden (HH:MM:SS, sonst null)
- Gesamtbetrag in Euro als Zahl (bei Rechnungen der Brutto-/Endbetrag)
- Alle Positionen mit:
  * original_text: was wörtlich auf dem Beleg steht (mit Abkürzungen)
  * name: ausgeschriebene Version
  * ai_guess: deine beste Vermutung des Produkts (z.B. "Hafermilch", "Vollkornbrot")
  * menge: Zahl falls erkennbar (sonst null)
  * einheit: "kg" | "l" | "ml" | "g" | "stk" | "" (leer wenn unklar)
  * preis: Euro als Zahl, Komma → Punkt
  * kategorie: grobe Kategorie ("Obst", "Backwaren", "Drogerie", "Pfand", "Versand", ...)

Regeln:
- Kassenbon: PFAND-Zeilen als eigene Artikel mit kategorie="Pfand"; Coupon-Rabatte zwischen Artikeln ignorieren.
- Rechnung/Bestellung: jede bestellte Position einzeln auflisten; Versandkosten als eigene Position mit kategorie="Versand"; Rabatte/Gutscheine ignorieren; bei Netto/MwSt/Brutto den Brutto-Endbetrag als gesamt_betrag nehmen.
- NUR bei wirklich unlesbaren Bildern ODER Dokumenten, die gar KEIN Kaufbeleg sind (reine Werbung, Newsletter, Versandbenachrichtigung ohne Beträge): confidence < 0.3 und leere artikel.
- Bei klar lesbarem Beleg/Rechnung: confidence 0.85-1.0.

JSON-Schema:
{"confidence": 0.0-1.0, "ladenkette": "...", "filiale": "..." | null, "datum": "YYYY-MM-DD", "uhrzeit": "HH:MM:SS" | null, "gesamt_betrag": 12.34, "artikel": [...]}`;

/** Detect the real image type from magic bytes — phone photos often have a
 *  misleading extension (a ".jpg" that's actually WEBP/HEIC), and Anthropic
 *  rejects the request when the bytes don't match the declared media_type. */
function sniffMediaType(buf: Buffer): string | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.length >= 4 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** HEIC/HEIF (default iPhone photo format) is NOT accepted by the vision API. */
function isHeic(buf: Buffer): boolean {
  if (buf.length < 12 || buf.toString('ascii', 4, 8) !== 'ftyp') return false;
  return /^(heic|heix|hevc|hevx|mif1|msf1)/.test(buf.toString('ascii', 8, 12));
}

export interface OcrArtikel {
  original_text?: string;
  name?: string;
  ai_guess?: string;
  menge?: number | string | null;
  einheit?: string;
  preis?: number | string | null;
  kategorie?: string;
}

export interface OcrResult {
  confidence: number;
  ladenkette: string;
  filiale: string | null;
  datum: string;
  uhrzeit: string | null;
  gesamt_betrag: number;
  artikel: OcrArtikel[];
  usage?: { input_tokens: number; output_tokens: number };
}

/** Runs vision OCR on an image. Source can be a local filesystem path
 *  (preferred — fastest, no roundtrip) or an absolute URL. The provider
 *  and model are taken from the `ai.ocr.*` config — currently only
 *  Anthropic Vision is implemented. */
export async function ocrFromImage(source: string): Promise<OcrResult> {
  const provider = await getConfig('ai.ocr.provider');
  const model = await getConfig('ai.ocr.model');
  if (provider !== 'anthropic') {
    throw new Error(`OCR provider "${provider}" not implemented yet — only "anthropic" is supported`);
  }
  const url = await getConfig('anthropic.url');
  const apiKey = await getConfig('anthropic.api_key');
  if (!apiKey) throw new Error('anthropic.api_key not configured');

  let buf: Buffer;
  if (/^https?:\/\//i.test(source)) {
    const imgRes = await fetch(source, { signal: AbortSignal.timeout(60_000) });
    if (!imgRes.ok) throw new Error(`image fetch failed: HTTP ${imgRes.status}`);
    buf = Buffer.from(await imgRes.arrayBuffer());
  } else {
    // Relative URL or filesystem path → read from disk.
    buf = await readFile(source);
  }
  const b64 = buf.toString('base64');
  const isPdf = (buf.length >= 4 && buf.toString('ascii', 0, 4) === '%PDF') || /\.pdf$/i.test(source);
  if (!isPdf && isHeic(buf)) {
    throw new Error('HEIC/HEIF-Fotos werden vom Vision-Modell nicht unterstützt — bitte als JPEG oder PNG hochladen (iPhone: Einstellungen → Kamera → Formate → "Maximale Kompatibilität").');
  }
  // Trust the actual bytes over the extension; fall back to the extension only if unrecognised.
  const mediaType = sniffMediaType(buf) ?? (/\.png$/i.test(source) ? 'image/png' : 'image/jpeg');
  // A PDF invoice (common for utilities/telecom/online orders) is sent as a
  // `document` block — native PDF understanding, no rasteriser needed. An image
  // goes in an `image` block. Same vision model, same JSON contract.
  const docBlock = isPdf
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } }
    : { type: 'image', source: { type: 'base64', media_type: mediaType, data: b64 } };

  const res = await fetch(`${url}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      // Headroom for long receipts AND for thinking models (e.g. Sonnet 5) that spend
      // part of the budget on a hidden thinking block before the JSON.
      max_tokens: 16384,
      system: VISION_SYSTEM,
      messages: [{
        role: 'user',
        content: [
          docBlock,
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
  const data = await res.json() as { content?: { type?: string; text?: string }[]; usage?: { input_tokens: number; output_tokens: number } };
  // Thinking models (Sonnet 5) return [thinking, text]; the JSON is the first TEXT block, not content[0].
  const text = (data.content ?? []).find(c => c.type === 'text')?.text ?? '';
  const parsed = parseLlmJson<OcrResult>(text);
  parsed.usage = data.usage;
  await recordUsage('ocr', 'anthropic', model, data.usage?.input_tokens ?? 0, data.usage?.output_tokens ?? 0);
  return parsed;
}

const TEXT_SYSTEM = `Du bist ein Datenextraktions-Assistent für Rechnungen und Bestellbestätigungen aus E-Mails (Online-Shops, Lieferdienste, Versorger).
Antworte AUSSCHLIESSLICH mit gültigem JSON ohne Markdown-Fence, ohne Kommentare.

Aus dem E-Mail-Text extrahieren:
- Ladenkette/Händler (kurz, z.B. "Amazon", "Zalando", "Lieferando", "Telekom")
- Filiale/Adresse falls vorhanden (sonst null)
- Datum (YYYY-MM-DD) — Bestell- oder Rechnungsdatum
- Uhrzeit falls vorhanden (HH:MM:SS, sonst null)
- Gesamtbetrag in Euro als Zahl
- Alle Positionen mit:
  * original_text: wie im Text genannt
  * name: ausgeschriebene Version
  * ai_guess: beste Vermutung des Produkts
  * menge: Zahl falls erkennbar (sonst null)
  * einheit: "kg" | "l" | "ml" | "g" | "stk" | "" (leer wenn unklar)
  * preis: Euro als Zahl, Komma → Punkt
  * kategorie: grobe Kategorie

Regeln:
- Versandkosten als eigene Position mit kategorie="Versand"
- Rabatte/Gutscheine zwischen Positionen ignorieren
- Wenn der Text KEINE Rechnung/Bestellung ist (Newsletter, Werbung, reine Versandbenachrichtigung ohne Beträge): confidence < 0.3, leere artikel, ladenkette ""
- Bei klar erkennbarer Rechnung: confidence 0.85-1.0

JSON-Schema:
{"confidence": 0.0-1.0, "ladenkette": "...", "filiale": "..." | null, "datum": "YYYY-MM-DD", "uhrzeit": "HH:MM:SS" | null, "gesamt_betrag": 12.34, "artikel": [...]}`;

/** Extracts receipt/invoice data from the plain-text (or stripped-HTML) body of
 *  an e-mail — for invoices delivered inline rather than as a PDF/image
 *  attachment (e.g. shop order confirmations). Same provider/model/JSON contract
 *  as ocrFromImage; the caller decides whether the result is usable (low
 *  confidence + empty artikel ⇒ "this wasn't a receipt"). */
export async function ocrFromText(text: string): Promise<OcrResult> {
  const provider = await getConfig('ai.ocr.provider');
  const model = await getConfig('ai.ocr.model');
  if (provider !== 'anthropic') {
    throw new Error(`OCR provider "${provider}" not implemented yet — only "anthropic" is supported`);
  }
  const url = await getConfig('anthropic.url');
  const apiKey = await getConfig('anthropic.api_key');
  if (!apiKey) throw new Error('anthropic.api_key not configured');

  const res = await fetch(`${url}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 16384,
      system: TEXT_SYSTEM,
      messages: [{ role: 'user', content: [{ type: 'text', text: text.slice(0, 24000) }] }],
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json() as { content?: { type?: string; text?: string }[]; usage?: { input_tokens: number; output_tokens: number } };
  // Thinking models (Sonnet 5) return [thinking, text]; take the first TEXT block, not content[0].
  const out = (data.content ?? []).find(c => c.type === 'text')?.text ?? '';
  const parsed = parseLlmJson<OcrResult>(out);
  parsed.usage = data.usage;
  await recordUsage('ocr', 'anthropic', model, data.usage?.input_tokens ?? 0, data.usage?.output_tokens ?? 0);
  return parsed;
}

const PAYSLIP_SYSTEM = `Du bist ein Datenextraktions-Assistent für deutsche Gehaltsabrechnungen / Lohnabrechnungen (z.B. DATEV).
Antworte AUSSCHLIESSLICH mit gültigem JSON ohne Markdown-Fence, ohne Kommentare.

Aus der Abrechnung (Bild ODER PDF) extrahieren:
- arbeitgeber: Name des Arbeitgebers/der Firma (oben auf der Abrechnung), sonst null
- arbeitnehmer: Name des Beschäftigten, sonst null
- monat: Abrechnungsmonat als "YYYY-MM" (aus "Abrechnung 07/2026", "Juli 2026", Abrechnungszeitraum …)
- brutto: Gesamt-Brutto/Steuerbrutto als Zahl in Euro (Komma → Punkt)
- netto: AUSZAHLUNGSBETRAG — der tatsächlich überwiesene Netto-Betrag ("Auszahlungsbetrag", "Überweisung", "Netto-Verdienst", "Auszahlung"). Das ist der wichtigste Wert.

Regeln:
- Wenn das Dokument KEINE Gehalts-/Lohnabrechnung ist (Werbung, anderer Beleg): confidence < 0.3 und netto/brutto null.
- Bei klar lesbarer Abrechnung: confidence 0.85-1.0.
- Nimm bei mehreren Beträgen für "netto" den AUSZAHLUNGSBETRAG (was auf dem Konto ankommt), NICHT das Netto vor Abzügen wie Sachbezügen.

JSON-Schema:
{"confidence": 0.0-1.0, "arbeitgeber": "..." | null, "arbeitnehmer": "..." | null, "monat": "YYYY-MM" | null, "brutto": 1234.56 | null, "netto": 987.65 | null}`;

export interface PayslipResult {
  confidence: number;
  arbeitgeber: string | null;
  arbeitnehmer: string | null;
  monat: string | null;
  brutto: number | null;
  netto: number | null;
  usage?: { input_tokens: number; output_tokens: number };
}

/** Extract salary data from an uploaded pay-slip PDF/image (Anthropic Vision).
 *  Same provider/model/contract as the receipt OCR; the caller turns a usable
 *  result into an `income` row. Takes the raw bytes (from a web upload). */
export async function extractPayslip(buf: Buffer): Promise<PayslipResult> {
  const provider = await getConfig('ai.ocr.provider');
  const model = await getConfig('ai.ocr.model');
  if (provider !== 'anthropic') throw new Error(`OCR provider "${provider}" not implemented yet — only "anthropic" is supported`);
  const url = await getConfig('anthropic.url');
  const apiKey = await getConfig('anthropic.api_key');
  if (!apiKey) throw new Error('anthropic.api_key not configured');

  const b64 = buf.toString('base64');
  const isPdf = (buf.length >= 4 && buf.toString('ascii', 0, 4) === '%PDF');
  if (!isPdf && isHeic(buf)) {
    throw new Error('HEIC/HEIF-Fotos werden vom Vision-Modell nicht unterstützt — bitte als PDF, JPEG oder PNG hochladen.');
  }
  const mediaType = sniffMediaType(buf) ?? 'image/jpeg';
  const docBlock = isPdf
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } }
    : { type: 'image', source: { type: 'base64', media_type: mediaType, data: b64 } };

  const res = await fetch(`${url}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model,
      max_tokens: 8192,
      system: PAYSLIP_SYSTEM,
      messages: [{ role: 'user', content: [docBlock, { type: 'text', text: 'Extrahiere die Gehaltsdaten als JSON.' }] }],
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`Anthropic HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json() as { content?: { type?: string; text?: string }[]; usage?: { input_tokens: number; output_tokens: number } };
  const out = (data.content ?? []).find(c => c.type === 'text')?.text ?? '';
  const parsed = parseLlmJson<PayslipResult>(out);
  parsed.usage = data.usage;
  await recordUsage('ocr', 'anthropic', model, data.usage?.input_tokens ?? 0, data.usage?.output_tokens ?? 0);
  return parsed;
}
