import { readFile } from 'node:fs/promises';
import { getConfig } from '../config.js';
import { parseLlmJson } from './ollama.js';
import { recordUsage } from './provider.js';

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
  const mediaType = /\.png$/i.test(source) ? 'image/png' : 'image/jpeg';

  const res = await fetch(`${url}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
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
  const data = await res.json() as { content?: { text?: string }[]; usage?: { input_tokens: number; output_tokens: number } };
  const text = data.content?.[0]?.text ?? '';
  const parsed = parseLlmJson<OcrResult>(text);
  parsed.usage = data.usage;
  await recordUsage('ocr', 'anthropic', model, data.usage?.input_tokens ?? 0, data.usage?.output_tokens ?? 0);
  return parsed;
}
