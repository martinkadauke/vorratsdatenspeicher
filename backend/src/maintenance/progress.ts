import sql from '../db.js';

export interface JobProgress {
  phase: string;      // 'recategorize' | 'canonical' | 'store_icons' | ...
  current: number;
  total: number;
  label?: string;     // optional human hint, e.g. the item being processed
}

/** Throttled progress writer for a maintenance_event row. Avoids hammering
 *  the DB on every single item — only flushes every `minIntervalMs`. */
export class ProgressReporter {
  private lastFlush = 0;
  constructor(private eventId: number, private minIntervalMs = 1000) {}

  /** Update progress; writes to DB at most once per interval (force=true always writes). */
  async set(p: JobProgress, force = false): Promise<void> {
    const now = Date.now();
    if (!force && now - this.lastFlush < this.minIntervalMs) return;
    this.lastFlush = now;
    await sql`UPDATE maintenance_event SET progress = ${sql.json(p as never)} WHERE id = ${this.eventId}`;
  }

  /** Clear progress (job finished). */
  async clear(): Promise<void> {
    await sql`UPDATE maintenance_event SET progress = NULL WHERE id = ${this.eventId}`;
  }
}
