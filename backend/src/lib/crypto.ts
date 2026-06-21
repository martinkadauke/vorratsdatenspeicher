import crypto from 'node:crypto';

/** Symmetric encryption for at-rest secrets (currently per-user IMAP passwords).
 *
 *  AES-256-GCM. The key is derived (SHA-256) from MAILBOX_ENC_KEY, falling back
 *  to JWT_SECRET so the feature works out-of-the-box in every environment without
 *  a new secret to provision — still far better than the plaintext that app_config
 *  uses for global secrets. Set a dedicated MAILBOX_ENC_KEY in prod to decouple the
 *  two. Rotating the key invalidates stored passwords (users re-enter them); a bad
 *  key surfaces as a decrypt error on the next poll, not silent garbage (GCM auth
 *  tag is verified). */
const KEY = crypto
  .createHash('sha256')
  .update(process.env.MAILBOX_ENC_KEY ?? process.env.JWT_SECRET ?? 'dev-secret-change-me')
  .digest();

/** Returns "v1:iv:tag:ciphertext" with each part base64-encoded. The version
 *  prefix lets a future key rotation distinguish formats without guessing. */
export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join(':');
}

/** Inverse of encryptSecret. Throws if the blob is malformed or the auth tag
 *  fails (wrong key / tampering — the caller surfaces this as "re-enter password").
 *  Accepts both the versioned "v1:…" form and the original unversioned 3-part form. */
export function decryptSecret(blob: string): string {
  const parts = blob.split(':');
  if (parts[0] === 'v1') parts.shift();
  const [ivB, tagB, encB] = parts;
  if (!ivB || !tagB || !encB) throw new Error('malformed ciphertext');
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(ivB, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(encB, 'base64')), decipher.final()]).toString('utf8');
}
