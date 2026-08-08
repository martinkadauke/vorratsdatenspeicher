import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import sql, { DEMO_MODE } from '../db.js';
import { requireAdmin, signToken } from '../auth/plugin.js';

// ── Inviting a household member ─────────────────────────────────────────────────────────────
//
// The existing auth_token invite makes the ADMIN create the account: know their e-mail, choose
// their password, own their login. This one does not. Only the MEMBER exists beforehand; the
// invited person turns it into their own account.
//
// Two factors on purpose, over two channels:
//   * the TOKEN is in the link, shared however you like (WhatsApp, Signal, a note)
//   * the CODE is shown on the ADMIN's screen and passed on out of band — spoken, called, read out
// Both in the same message would make the code decoration; keeping them apart is what makes
// intercepting the link insufficient.

const CODE_ATTEMPTS = 5;
const VALID_MINUTES = 30;

/** 4 digits, uniformly drawn. Short because a human retypes it; safe because the attempt counter
 *  below makes 10.000 possibilities plenty. */
const freshCode = (): string => String(crypto.randomInt(0, 10_000)).padStart(4, '0');

export function inviteRoutes(app: FastifyInstance): void {
  /** Admin: invite the person behind this member. Replaces any open invite for them — two live
   *  links for one person is a support case waiting to happen. */
  app.post<{ Body: { member_id?: number; make_admin?: boolean } }>('/api/invites', { preHandler: requireAdmin }, async (req, reply) => {
    if (DEMO_MODE) return reply.code(403).send({ error: 'forbidden' });
    const memberId = Number(req.body?.member_id);
    if (!Number.isInteger(memberId)) return reply.code(400).send({ error: 'member_id required' });

    const [member] = await sql`SELECT id, name, user_id FROM family_member WHERE id = ${memberId} AND archived_at IS NULL`;
    if (!member) return reply.code(404).send({ error: 'no_such_member' });
    // One member, at most one login — the whole point of the model. Inviting someone who already
    // has an account would either create a second one or fail on the unique index later.
    if (member.user_id != null) return reply.code(409).send({ error: 'already_has_account' });

    const token = crypto.randomBytes(24).toString('base64url');
    const code = freshCode();
    const [row] = await sql.begin(async (tx) => {
      await tx`DELETE FROM member_invite WHERE family_member_id = ${memberId} AND used_at IS NULL`;
      return tx`
        INSERT INTO member_invite (family_member_id, token, code, make_admin, expires_at, created_by)
        VALUES (${memberId}, ${token}, ${code}, ${!!req.body?.make_admin},
                NOW() + ${`${VALID_MINUTES} minutes`}::interval, ${req.user!.id})
        RETURNING id, token, code, expires_at`;
    });
    return { id: row.id, token: row.token, code: row.code, expires_at: row.expires_at, member: member.name };
  });

  /** Admin: open invites, so the pending row can show the code until it is redeemed. */
  app.get('/api/invites', { preHandler: requireAdmin }, async () => {
    return sql`
      SELECT i.id, i.family_member_id, i.token, i.code, i.make_admin, i.attempts, i.expires_at,
             fm.name AS member, (i.expires_at < NOW()) AS expired
      FROM member_invite i JOIN family_member fm ON fm.id = i.family_member_id
      WHERE i.used_at IS NULL
      ORDER BY i.created_at DESC`;
  });

  app.delete('/api/invites/:id', { preHandler: requireAdmin }, async (req) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    await sql`DELETE FROM member_invite WHERE id = ${id} AND used_at IS NULL`;
    return { ok: true };
  });

  /** Public: what is behind this link? Only the first name, so the page can greet properly.
   *  ⚠️ Never the code — that is the second factor and must not travel with the link. */
  app.get('/api/invite/:token', async (req, reply) => {
    const token = (req.params as { token: string }).token ?? '';
    const [row] = await sql`
      SELECT fm.name AS member, i.expires_at, i.attempts
      FROM member_invite i JOIN family_member fm ON fm.id = i.family_member_id
      WHERE i.token = ${token} AND i.used_at IS NULL`;
    if (!row) return reply.code(404).send({ valid: false });
    if (new Date(row.expires_at as string) < new Date()) return reply.code(410).send({ valid: false, reason: 'expired' });
    if ((row.attempts as number) >= CODE_ATTEMPTS) return reply.code(403).send({ valid: false, reason: 'locked' });
    return { valid: true, member: row.member };
  });

  /** Public: the invited person creates THEIR OWN account. Admin never sees the password and does
   *  not need the e-mail address at all. */
  app.post<{ Body: { code?: string; username?: string; password?: string; email?: string } }>('/api/invite/:token/redeem', async (req, reply) => {
    const token = (req.params as { token: string }).token ?? '';
    const code = String(req.body?.code ?? '').replace(/\D/g, '');
    const username = String(req.body?.username ?? '').trim();
    const password = String(req.body?.password ?? '');
    const email = String(req.body?.email ?? '').trim() || null;
    if (!username || password.length < 8) return reply.code(400).send({ error: 'invalid_credentials' });

    const [inv] = await sql`
      SELECT id, family_member_id, code, make_admin, attempts, expires_at
      FROM member_invite WHERE token = ${token} AND used_at IS NULL`;
    if (!inv) return reply.code(404).send({ error: 'unknown_invite' });
    if (new Date(inv.expires_at as string) < new Date()) return reply.code(410).send({ error: 'expired' });
    if ((inv.attempts as number) >= CODE_ATTEMPTS) return reply.code(403).send({ error: 'locked' });

    if (code !== inv.code) {
      // ⚠️ Count the failure BEFORE answering, and in the database — four digits are only safe
      // because this counter is real.
      const [after] = await sql`UPDATE member_invite SET attempts = attempts + 1 WHERE id = ${inv.id} RETURNING attempts`;
      return reply.code(403).send({ error: 'wrong_code', attempts_left: Math.max(0, CODE_ATTEMPTS - (after.attempts as number)) });
    }

    try {
      const hash = await bcrypt.hash(password, 12);
      const userId = await sql.begin(async (tx) => {
        const [u] = await tx`
          INSERT INTO users (username, email, password_hash, is_admin, sees_all_konten)
          VALUES (${username}, ${email}, ${hash}, ${!!inv.make_admin}, ${!!inv.make_admin})
          RETURNING id`;
        // The member is the person; this is where they gain a way in. Their bank accounts came
        // with the member and need no separate step.
        await tx`UPDATE family_member SET user_id = ${u.id} WHERE id = ${inv.family_member_id}`;
        await tx`UPDATE member_invite SET used_at = NOW() WHERE id = ${inv.id}`;
        return u.id as number;
      });
      req.log.info(`invite redeemed: member ${inv.family_member_id} → user "${username}"`);
      return { token: signToken(userId) };
    } catch (e) {
      // Unique violation on username is the realistic case; say so instead of a 500.
      if (String((e as { code?: string }).code) === '23505') return reply.code(409).send({ error: 'username_taken' });
      throw e;
    }
  });
}
