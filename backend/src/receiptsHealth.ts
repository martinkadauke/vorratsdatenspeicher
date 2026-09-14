import { readdir } from 'node:fs/promises';
import sql, { DEMO_MODE } from './db.js';
import { sendPush } from './push.js';

/**
 * Watches the receipts directory and says so, out loud, when it stops working.
 *
 * This exists because of the same failure twice, and both times the worst part was the silence:
 * on 2026-08-26 production served ZERO receipt photos for three days, and on 2026-09-09 five of
 * six containers did for four days — both behind a green healthcheck, an app that answered every
 * request, and nobody any the wiser. The receipts live on a NAS over NFS, and when its handles go
 * stale the directory turns into an error while everything else keeps working perfectly.
 *
 * The root cause is fixed elsewhere (the share is exported from a real filesystem now, not from
 * Unraid's FUSE layer — see deploy/stack.yml). This is the net underneath: if it ever happens
 * again, somebody finds out the same day instead of the same week.
 *
 * ⚠️ Deliberately NOT wired into the container healthcheck. An unhealthy container gets restarted
 * by Swarm, which fixes a merely stale mount — but on 2026-09-14 the Docker daemon itself held the
 * dead reference and every restart failed with the same error. Tied to the healthcheck, the whole
 * service would have restart-looped down to zero replicas: "no photos" would have become "no app".
 * Reporting is strictly better than a cure that can kill the patient.
 */

export type ReceiptsState = {
  ok: boolean;
  /** errno when broken — ESTALE means the NFS handle died, which is the case we care about. */
  code: string | null;
  message: string | null;
  checkedAt: string;
  /** Since when it has been broken, so a report can say "four days" instead of "now". */
  brokenSince: string | null;
};

let state: ReceiptsState = { ok: true, code: null, message: null, checkedAt: new Date(0).toISOString(), brokenSince: null };

export function receiptsHealth(): ReceiptsState {
  return state;
}

/**
 * A stale NFS handle fails INSTANTLY with ESTALE. A NAS that is merely switched off hangs until
 * the mount's own timeout (soft,timeo=600 → a minute) and then fails with EIO or ETIMEDOUT.
 * Only the first kind is worth waking somebody for: it does not heal on its own and it is
 * invisible from the outside. A NAS that is off is a fact the household already knows.
 */
const BROKEN_CODES = new Set(['ESTALE', 'ENOTCONN', 'ENOENT']);

async function checkOnce(dir: string): Promise<ReceiptsState> {
  const checkedAt = new Date().toISOString();
  try {
    await readdir(dir);
    return { ok: true, code: null, message: null, checkedAt, brokenSince: null };
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    const code = err.code ?? 'UNKNOWN';
    return {
      ok: !BROKEN_CODES.has(code),
      code,
      message: String(err.message ?? err).slice(0, 200),
      checkedAt,
      brokenSince: null,
    };
  }
}

/** Everyone who can act on it. */
async function admins(): Promise<number[]> {
  try {
    const rows = await sql`SELECT id FROM users WHERE is_admin = TRUE`;
    return rows.map(r => r.id as number);
  } catch { return []; }
}

/**
 * Start watching. Logs only on TRANSITIONS — a line every minute for four days would be its own
 * kind of silence, the kind nobody reads.
 */
export function startReceiptsWatch(dir: string, log: { warn: (m: string) => void; info: (m: string) => void }): void {
  if (DEMO_MODE) return;                       // the demo has no NAS and no household to warn
  const INTERVAL_MS = 60_000;

  const tick = async () => {
    const next = await checkOnce(dir);
    const was = state;
    // Keep the original breakage time across repeated failures: how LONG it has been broken is
    // the number that turns a shrug into action.
    state = { ...next, brokenSince: next.ok ? null : (was.brokenSince ?? next.checkedAt) };

    if (was.ok && !state.ok) {
      log.warn(`receipts directory unusable (${state.code}): ${state.message} — photos cannot be read or written`);
      const payload = {
        title: 'Belege nicht erreichbar',
        body: 'VDS kann den Belege-Ordner nicht lesen. Fotos fehlen und neue lassen sich nicht speichern.',
        url: '/verwaltung',
        tag: 'receipts-broken',              // replaces itself instead of stacking up
      };
      for (const id of await admins()) {
        try { await sendPush(id, payload); } catch { /* a notification must never break the app */ }
      }
    } else if (!was.ok && state.ok) {
      const since = was.brokenSince ? new Date(was.brokenSince) : null;
      const mins = since ? Math.round((Date.now() - since.getTime()) / 60000) : null;
      log.info(`receipts directory readable again${mins !== null ? ` (was broken for ${mins} min)` : ''}`);
    }
  };

  void tick();
  const timer = setInterval(() => { void tick(); }, INTERVAL_MS);
  timer.unref?.();
}
