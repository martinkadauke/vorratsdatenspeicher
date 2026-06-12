import sql from '../db.js';

export interface JobProgress {
  phase: string;      // 'recategorize' | 'canonical' | 'store_icons' | ...
  current: number;
  total: number;
  label?: string;     // optional human hint, e.g. the item being processed
  ts?: number;        // server timestamp of last write (for cross-replica freshness)
}

/** How long a 'running' event's progress stays "fresh" before the status
 *  endpoint treats it as a dead orphan. Generous because slow Ollama models
 *  can take a while between per-item progress writes. */
export const PROGRESS_FRESH_MS = 5 * 60 * 1000;

/** Throttled progress writer for a maintenance_event row. Avoids hammering
 *  the DB on every single item — only flushes every `minIntervalMs`, but
 *  always flushes immediately when the phase changes (so the UI label
 *  switches promptly) or when force=true. */
export class ProgressReporter {
  private lastFlush = 0;
  private lastPhase = '';
  constructor(private eventId: number, private minIntervalMs = 1000) {}

  async set(p: JobProgress, force = false): Promise<void> {
    const now = Date.now();
    const phaseChanged = p.phase !== this.lastPhase;
    if (!force && !phaseChanged && now - this.lastFlush < this.minIntervalMs) return;
    this.lastFlush = now;
    this.lastPhase = p.phase;
    const payload = { ...p, ts: now };
    await sql`UPDATE maintenance_event SET progress = ${sql.json(payload as never)} WHERE id = ${this.eventId}`;
  }

  async clear(): Promise<void> {
    await sql`UPDATE maintenance_event SET progress = NULL WHERE id = ${this.eventId}`;
  }
}
