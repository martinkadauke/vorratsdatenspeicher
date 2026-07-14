import type { FastifyInstance } from 'fastify';
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { requireSuperAdmin } from '../auth/plugin.js';
import { INTERNAL_SECRET } from '../config.js';

const RECEIPTS_LOCAL_PATH = process.env.RECEIPTS_LOCAL_PATH ?? '/receipts';
const TTL_MS = 10 * 60_000; // signed download link valid 10 min

function sign(exp: number): string {
  return crypto.createHmac('sha256', INTERNAL_SECRET).update(`backup:${exp}`).digest('hex');
}
function valid(e?: string, s?: string): boolean {
  if (!e || !s) return false;
  const exp = Number(e);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  const expected = sign(exp);
  const a = Buffer.from(s);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Super-admin full backup: one .tar.gz containing a pg_dump (database.sql) + every
 *  receipt file. Two endpoints so the browser can stream a large archive straight to
 *  disk: prepare (authed) mints a short-lived signed URL; download (single request →
 *  stays on one replica) does the pg_dump + tar and streams it. */
export function backupRoutes(app: FastifyInstance): void {
  app.get('/api/backup/prepare', { preHandler: requireSuperAdmin }, async () => {
    const exp = Date.now() + TTL_MS;
    return { url: `/api/backup/download?e=${exp}&s=${sign(exp)}` };
  });

  app.get('/api/backup/download', async (req, reply) => {
    const { e, s } = req.query as { e?: string; s?: string };
    if (!valid(e, s)) return reply.code(403).send({ error: 'forbidden' });

    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) return reply.code(500).send({ error: 'DATABASE_URL not set' });

    const tmp = await mkdtemp(path.join(tmpdir(), 'vds-backup-'));
    const sqlPath = path.join(tmp, 'database.sql');
    try {
      // 1) pg_dump → temp file (small; awaited so we can report failures cleanly)
      await new Promise<void>((resolve, rejectDump) => {
        const dump = spawn('pg_dump', ['--no-owner', '--no-privileges', dbUrl]);
        let err = '';
        dump.stderr.on('data', d => { err += d.toString(); });
        dump.on('error', rejectDump);
        dump.stdout.pipe(createWriteStream(sqlPath));
        dump.on('close', code => code === 0 ? resolve() : rejectDump(new Error(`pg_dump exit ${code}: ${err.slice(0, 400)}`)));
      });

      // 2) stream a gzipped tar of database.sql + the receipts dir → the response
      const label = (process.env.VDS_ENV || process.env.GIT_REF || 'vds').replace(/[^a-z0-9]/gi, '') || 'vds';
      const stamp = new Date().toISOString().slice(0, 10);
      reply.header('Content-Type', 'application/gzip');
      reply.header('Content-Disposition', `attachment; filename="vds-backup-${label}-${stamp}.tar.gz"`);

      const args = ['-czf', '-', '-C', tmp, 'database.sql'];
      if (existsSync(RECEIPTS_LOCAL_PATH)) {
        args.push('-C', path.dirname(RECEIPTS_LOCAL_PATH), path.basename(RECEIPTS_LOCAL_PATH));
      }
      const tar = spawn('tar', args);
      tar.on('error', er => reply.raw.destroy(er));
      reply.raw.on('close', () => { void rm(tmp, { recursive: true, force: true }); });
      return reply.send(tar.stdout);
    } catch (err) {
      await rm(tmp, { recursive: true, force: true }).catch(() => {});
      req.log.error(`backup failed: ${(err as Error).message}`);
      if (!reply.sent) return reply.code(500).send({ error: (err as Error).message });
    }
  });
}
