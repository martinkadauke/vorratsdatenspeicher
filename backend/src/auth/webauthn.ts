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
import sql from '../db.js';
import { getConfig, effectiveBaseUrl } from '../config.js';
import { signToken } from './plugin.js';

/** Relying-party identity. RP-ID = the canonical hostname (no scheme/port), origin = the full
 *  origin (WITH port). Both are derived from app.base_url and overridable via config — on the
 *  Electron+Tunnel build this is the stable Tailscale-Funnel hostname for every device (the one
 *  RP-ID all passkeys are bound to). Self-hosters behind their own proxy get it from base_url. */
async function rpConfig(): Promise<{ rpID: string; origin: string; rpName: string }> {
  const base = (await effectiveBaseUrl()) || 'http://localhost';
  let hostname = 'localhost';
  let origin = base;
  try { const u = new URL(base); hostname = u.hostname; origin = u.origin; } catch { /* keep localhost defaults */ }
  const rpID = (await getConfig('webauthn.rp_id')) || hostname;
  const rpOrigin = (await getConfig('webauthn.origin')) || origin;
  return { rpID, origin: rpOrigin, rpName: 'Vorratsdatenspeicher' };
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
  // ── Register a new passkey for the signed-in user ──────────────────────────
  app.post('/api/auth/passkey/register/options', async (req) => {
    const user = req.user!;
    const { rpID, rpName } = await rpConfig();
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
    const { rpID, origin } = await rpConfig();
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
  app.post('/api/auth/passkey/login/options', async () => {
    const { rpID } = await rpConfig();
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
    const { rpID, origin } = await rpConfig();
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
