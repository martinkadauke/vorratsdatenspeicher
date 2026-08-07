import type { FastifyInstance } from 'fastify';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { requireOperator } from '../auth/plugin.js';
import { DEMO_MODE } from '../db.js';

// ── Desktop bridge: "Handy verbinden" ───────────────────────────────────────────────────────
// Only the Electron build sets DESKTOP_DIR; in Docker these endpoints report unavailable and do
// nothing, so ONE frontend serves both channels (a container is already on the network — it has
// no use for a tunnel).
//
// VDS itself has no business starting a Tailscale node, and it deliberately cannot: the Electron
// shell owns that process. This module only WRITES a request marker the shell watches and READS
// the status the shell publishes — the same unprivileged-marker design as /api/self-update. Even
// a fully compromised app can ask for exactly two things here: tunnel on, tunnel off.
const DESKTOP_DIR = process.env.DESKTOP_DIR || '';
const desktopBuild = (): boolean => DESKTOP_DIR !== '';

/** The shell's view of the tunnel. Missing/garbled file → "off": the shell writes it on every
 *  state change, so its absence means nothing has ever been started. */
async function readStatus(): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(path.join(DESKTOP_DIR, 'tunnel-status.json'), 'utf8');
    const s = JSON.parse(raw);
    return s && typeof s === 'object' ? s : { state: 'off' };
  } catch {
    return { state: 'off' };
  }
}

export function desktopRoutes(app: FastifyInstance): void {
  /** Tunnel status for the connect-phone dialog. Operator-only: the public address of the
   *  household's own instance is not something a guest account should be able to read. */
  app.get('/api/desktop/tunnel', { preHandler: requireOperator }, async () => {
    if (!desktopBuild()) return { available: false, state: 'unavailable' };
    return { available: true, ...(await readStatus()) };
  });

  /** Ask the shell to bring the tunnel up or take it down. The action is a closed set and the
   *  shell re-validates it; nothing here reaches the network. */
  app.post<{ Body: { action?: string } }>('/api/desktop/tunnel', { preHandler: requireOperator }, async (req, reply) => {
    if (DEMO_MODE) return reply.code(403).send({ error: 'forbidden' });
    if (!desktopBuild()) return reply.code(409).send({ error: 'not_desktop' });
    const action = req.body?.action === 'stop' ? 'stop' : 'start';
    try {
      await mkdir(DESKTOP_DIR, { recursive: true });
      await writeFile(path.join(DESKTOP_DIR, 'tunnel-request'), `${action}\n`, 'utf8');
    } catch (e) {
      return reply.code(500).send({ error: 'shell_unreachable', detail: String((e as Error)?.message ?? e).slice(0, 200) });
    }
    return { ok: true, action };
  });
}
