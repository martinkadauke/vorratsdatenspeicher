import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import type {
  AuthenticatorTransportFuture,
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
} from '@simplewebauthn/server';
import sql, { DEMO_MODE } from '../db.js';
import { getConfig, effectiveBaseUrl } from '../config.js';
import { desktopBaseUrl } from '../desktop.js';
import { signToken } from './plugin.js';

/** Relying-party identity, derived from the origin the REQUEST actually came from.
 *
 *  ⚠️ Not from a single global base URL, and that distinction is the whole bug: the desktop build
 *  prefers the public tunnel address for anything a human will click in an e-mail — correct there —
 *  but the window itself runs on http://localhost:<port>. WebAuthn requires the RP ID to be a
 *  registrable suffix of the page's OWN domain, so a tunnel-derived RP ID made the browser refuse
 *  every registration on the desktop, before a single byte reached us. No server error to find,
 *  just a red toast.
 *
 *  Only origins we recognise are honoured, so a stray Origin header cannot make us mint
 *  credentials for someone else's domain. An explicit config override still wins — that is the
 *  self-hoster behind their own proxy telling us the truth.
 *
 *  ⚠️ Consequence worth knowing: a passkey is bound to ONE RP ID. One created at the computer
 *  (localhost) does not work through the tunnel and vice versa. That is inherent to WebAuthn and
 *  mostly harmless — every device registers its own passkey anyway.
 */
async function rpConfig(req?: { headers: Record<string, unknown> }): Promise<{ rpID: string; origin: string; rpName: string }> {
  const cfgID = await getConfig('webauthn.rp_id');
  const cfgOrigin = await getConfig('webauthn.origin');
  if (cfgID && cfgOrigin) return { rpID: cfgID, origin: cfgOrigin, rpName: 'Vorratsdatenspeicher' };

  const hostOf = (u: string): { id: string; origin: string } | null => {
    try { const x = new URL(u); return { id: x.hostname, origin: x.origin }; } catch { return null; }
  };

  // Everything this instance may legitimately be reached at.
  const allowed = [await effectiveBaseUrl(), desktopBaseUrl(), await getConfig('app.base_url')]
    .filter(Boolean).map(hostOf).filter((v): v is { id: string; origin: string } => !!v);
  const reqOrigin = String(req?.headers?.origin ?? '');
  const fromReq = hostOf(reqOrigin);
  const isLoopback = !!fromReq && ['localhost', '127.0.0.1', '[::1]', '::1'].includes(fromReq.id);

  // ⚠️ An HTTPS request from a real domain IS this instance, whatever the configured base URL
  // says. Requiring a match against that list broke every Docker self-host reached through a
  // reverse proxy — the common case, not an exotic one: with app.base_url pointing at a LAN
  // address, the fallback made the RP ID an IP, which browsers reject outright, so passkeys failed
  // identically in the desktop browser and the phone's PWA with nothing in any log.
  //
  // Trusting the origin here is not a hole. A browser only ever offers a page's OWN domain as the
  // RP ID, so this cannot mint a credential for a domain the caller does not already control, and
  // an assertion is still verified against the RP ID the credential was created with. Secure
  // context is required, which is what WebAuthn demands anyway — plus loopback, the one plain-HTTP
  // origin browsers treat as secure, and where the desktop window lives.
  const trustworthy = !!fromReq && (isLoopback || fromReq.origin.startsWith('https://'));

  const match = fromReq && (trustworthy || allowed.some(a => a.origin === fromReq.origin)) ? fromReq : null;
  const fallback = allowed[0] ?? hostOf('http://localhost')!;
  const chosen = match ?? fallback;
  return { rpID: cfgID || chosen.id, origin: cfgOrigin || chosen.origin, rpName: 'Vorratsdatenspeicher' };
}

/** Store a challenge server-side; the random handle is echoed back by the client on verify.
 *  Opportunistically prune expired rows so the table stays tiny. */
async function storeChallenge(purpose: 'register' | 'authenticate', challenge: string, userId: number | null): Promise<string> {
  const id = crypto.randomBytes(24).toString('base64url');
  await sql`DELETE FROM webauthn_challenge WHERE created_at < NOW() - INTERVAL '1 hour'`;
  await sql`INSERT INTO webauthn_challenge (id, challenge, user_id, purpose) VALUES (${id}, ${challenge}, ${userId}, ${purpose})`;
  return id;
}

/** Consume a challenge exactly once (DELETE ... RETURNING) — a replayed handle finds nothing.
 *  Rows older than 5 minutes are treated as expired. */
async function takeChallenge(id: string, purpose: 'register' | 'authenticate'): Promise<{ challenge: string; userId: number | null } | null> {
  const rows = await sql`
    DELETE FROM webauthn_challenge
    WHERE id = ${id} AND purpose = ${purpose} AND created_at > NOW() - INTERVAL '5 minutes'
    RETURNING challenge, user_id`;
  return rows.length ? { challenge: rows[0].challenge as string, userId: (rows[0].user_id as number | null) ?? null } : null;
}

/** Passkey (WebAuthn) registration + passwordless login. Registration/list/delete run behind the
 *  global auth hook (logged-in user); the two login routes are public (added to the hook's
 *  allow-list in plugin.ts). Passwords remain the recovery path, so passkeys are purely additive. */
export function webauthnRoutes(app: FastifyInstance): void {
  // ⚠️ Not on the public demo. A passkey binds a real device's authenticator to a throwaway
  // household that gets wiped nightly — the credential outlives the account it belongs to and
  // shows up in the person's password manager forever. Registering nothing is cleaner than
  // refusing at every route, and the two login routes stay out of the auth allow-list's reach
  // by simply not existing.
  if (DEMO_MODE) return;

  // ── Register a new passkey for the signed-in user ──────────────────────────
  app.post('/api/auth/passkey/register/options', async (req) => {
    const user = req.user!;
    const { rpID, rpName } = await rpConfig(req);
    const existing = await sql`SELECT credential_id, transports FROM webauthn_credential WHERE user_id = ${user.id}`;
    const options = await generateRegistrationOptions({
      rpName,
      rpID,
      userName: user.username,
      userDisplayName: user.username,
      userID: new TextEncoder().encode(String(user.id)),
      attestationType: 'none',
      excludeCredentials: existing.map(c => ({
        id: c.credential_id as string,
        transports: (c.transports as AuthenticatorTransportFuture[] | null) ?? undefined,
      })),
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
    });
    const challengeId = await storeChallenge('register', options.challenge, user.id);
    return { options, challengeId };
  });

  app.post('/api/auth/passkey/register/verify', async (req, reply) => {
    const user = req.user!;
    const { challengeId, response, name } = (req.body ?? {}) as { challengeId?: string; response?: RegistrationResponseJSON; name?: string };
    if (!challengeId || !response) return reply.code(400).send({ error: 'missing fields' });
    const ch = await takeChallenge(challengeId, 'register');
    if (!ch || ch.userId !== user.id) return reply.code(400).send({ error: 'challenge expired' });
    const { rpID, origin } = await rpConfig(req);
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response,
        expectedChallenge: ch.challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        requireUserVerification: false,
      });
    } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
    if (!verification.verified || !verification.registrationInfo) return reply.code(400).send({ error: 'not verified' });
    const cred = verification.registrationInfo.credential;
    const label = (typeof name === 'string' && name.trim() ? name.trim() : 'Passkey').slice(0, 60);
    const transports = cred.transports && cred.transports.length ? cred.transports : null;
    try {
      await sql`
        INSERT INTO webauthn_credential (user_id, credential_id, public_key, counter, transports, device_name)
        VALUES (${user.id}, ${cred.id}, ${Buffer.from(cred.publicKey)}, ${cred.counter}, ${transports}, ${label})`;
    } catch {
      return reply.code(409).send({ error: 'credential already registered' });
    }
    return { ok: true };
  });

  // ── Passwordless login (public — usernameless / discoverable credential) ───
  app.post('/api/auth/passkey/login/options', async (req) => {
    const { rpID } = await rpConfig(req);
    const options = await generateAuthenticationOptions({ rpID, userVerification: 'preferred', allowCredentials: [] });
    const challengeId = await storeChallenge('authenticate', options.challenge, null);
    return { options, challengeId };
  });

  app.post('/api/auth/passkey/login/verify', async (req, reply) => {
    const { challengeId, response } = (req.body ?? {}) as { challengeId?: string; response?: AuthenticationResponseJSON };
    if (!challengeId || !response?.id) return reply.code(400).send({ error: 'missing fields' });
    const ch = await takeChallenge(challengeId, 'authenticate');
    if (!ch) return reply.code(400).send({ error: 'challenge expired' });
    const rows = await sql`SELECT id, user_id, public_key, counter, transports FROM webauthn_credential WHERE credential_id = ${response.id}`;
    if (!rows.length) return reply.code(401).send({ error: 'unknown credential' });
    const row = rows[0];
    const { rpID, origin } = await rpConfig(req);
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: ch.challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        requireUserVerification: false,
        credential: {
          id: response.id,
          publicKey: new Uint8Array(row.public_key as Buffer),
          counter: Number(row.counter),
          transports: (row.transports as AuthenticatorTransportFuture[] | null) ?? undefined,
        },
      });
    } catch (e) { return reply.code(401).send({ error: (e as Error).message }); }
    if (!verification.verified) return reply.code(401).send({ error: 'not verified' });
    await sql`UPDATE webauthn_credential SET counter = ${verification.authenticationInfo.newCounter}, last_used_at = NOW() WHERE id = ${row.id}`;
    return { token: signToken(row.user_id as number) };
  });

  // ── Manage your own passkeys ───────────────────────────────────────────────
  app.get('/api/auth/passkey/list', async (req) => {
    const rows = await sql`
      SELECT id, device_name, created_at, last_used_at
      FROM webauthn_credential WHERE user_id = ${req.user!.id} ORDER BY created_at`;
    return { credentials: rows };
  });

  app.delete('/api/auth/passkey/:id', async (req, reply) => {
    const id = Number((req.params as { id?: string }).id);
    if (!Number.isFinite(id)) return reply.code(400).send({ error: 'bad id' });
    await sql`DELETE FROM webauthn_credential WHERE id = ${id} AND user_id = ${req.user!.id}`;
    return { ok: true };
  });
}
