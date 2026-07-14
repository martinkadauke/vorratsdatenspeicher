import crypto from 'node:crypto';
import { INTERNAL_SECRET } from '../config.js';

// Receipt images are served by the unauthenticated static /receipts/:file route (an <img>
// tag can't send a Bearer token). To stop a leaked image URL from being usable — or anyone
// fetching a receipt they couldn't already see — the backend appends a short-lived HMAC
// signature to every receipt-image URL in JSON responses (which are RLS-scoped, so a user
// only ever receives signed URLs for their own household). The static route refuses to
// serve without a valid, unexpired signature.

const TTL_MS = 6 * 60 * 60 * 1000; // 6 hours — long enough for an open page, short enough to limit a leak

/** Return the `?e=…&s=…` query to append to a `/receipts/<file>` path. */
export function signReceiptQuery(path: string): string {
  const e = Date.now() + TTL_MS;
  const s = crypto.createHmac('sha256', INTERNAL_SECRET).update(`${path}:${e}`).digest('base64url');
  return `?e=${e}&s=${s}`;
}

/** Verify a signature for `/receipts/<file>`; false if missing, tampered, or expired. */
export function verifyReceiptSig(path: string, e?: string, s?: string): boolean {
  if (!e || !s) return false;
  const exp = Number(e);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  const expected = crypto.createHmac('sha256', INTERNAL_SECRET).update(`${path}:${exp}`).digest('base64url');
  const a = Buffer.from(s);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
