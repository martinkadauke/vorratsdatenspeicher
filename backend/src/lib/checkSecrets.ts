/** Boot-time refusal to run with a guessable JWT_SECRET / INTERNAL_SECRET.
 *
 *  Why this exists: both secrets have a hard-coded fallback in config.ts (so `npm run dev` needs
 *  no setup), and INTERNAL_SECRET is the ONLY gate on GET /api/backup/download — an endpoint with
 *  no auth preHandler that streams a full pg_dump plus every receipt file. In a public repo, a
 *  self-hoster who omits the variable (or leaves the README's own "change-me-…" placeholder) is
 *  running with a secret the whole world knows. Verified exploitable: an unauthenticated caller
 *  can mint a valid signed link from the fallback constant and download the entire database.
 *
 *  So in production the app must NOT boot with a known value. It fails loudly with the fix in the
 *  message rather than starting up quietly insecure. In development the fallbacks stay usable —
 *  the guard only bites when NODE_ENV=production, which the image sets (Dockerfile) and a dev box
 *  does not.
 *
 *  This is the tourniquet, not the cure: the real fix (generate + persist a per-install secret so
 *  the compose file carries none) is the larger install-hardening epic. This shipped first because
 *  it closes a live data-exfiltration hole with ~no blast radius. */

// Every value that must never protect a real install: the config.ts fallbacks and the two
// placeholders the README's compose ships with. Compared case-insensitively and trimmed.
const KNOWN_BAD = new Set([
  'dev-secret-change-me',           // config.ts JWT_SECRET fallback
  'dev-internal-secret',            // config.ts INTERNAL_SECRET fallback
  'replace_me',                     // the current README placeholder — MUST stay caught
  'change-me-to-something-secret',  // older README placeholders
  'change-me-to-something-else',
  'changeme',
  'change-me',
  'secret',
]);

interface SecretProblem { name: string; reason: 'missing' | 'known-insecure'; }

function inspect(name: string): SecretProblem | null {
  const raw = process.env[name];
  if (raw === undefined) return { name, reason: 'missing' };
  const v = raw.trim();
  if (v === '') return { name, reason: 'missing' };
  if (KNOWN_BAD.has(v.toLowerCase())) return { name, reason: 'known-insecure' };
  return null;
}

/** Throws in production when a required secret is unset or a publicly known value; a no-op
 *  (with a one-line warning) in development so the config.ts fallbacks keep `npm run dev` working. */
export function checkSecrets(log: (msg: string) => void = console.warn): void {
  const problems = [inspect('JWT_SECRET'), inspect('INTERNAL_SECRET')].filter((p): p is SecretProblem => p !== null);
  if (problems.length === 0) return;

  const production = process.env.NODE_ENV === 'production';
  const lines = problems.map(p =>
    p.reason === 'missing'
      ? `  • ${p.name} is not set — it currently falls back to a value published in the source code.`
      : `  • ${p.name} is set to a well-known placeholder — change it to a real secret.`);

  if (!production) {
    log(`[secrets] insecure secret(s) detected (allowed only because NODE_ENV≠production):\n${lines.join('\n')}`);
    return;
  }

  // One command a self-hoster can copy. openssl is in the image and on virtually every host.
  const gen = 'openssl rand -hex 32';
  throw new Error(
    'Refusing to start with an insecure secret.\n' +
    lines.join('\n') + '\n\n' +
    `INTERNAL_SECRET in particular guards the full-backup download endpoint, so a known value there\n` +
    `lets anyone download your entire database. Set each secret to a unique random string — e.g.\n\n` +
    `    ${gen}\n\n` +
    `— and put the result in your compose file's environment for the vds service, then restart.`,
  );
}
