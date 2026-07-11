import postgres from 'postgres';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import bcrypt from 'bcryptjs';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/vorratsdatenspeicher';

const sql = postgres(DATABASE_URL, {
  onnotice: () => {},
  transform: { undefined: null },
});

export default sql;

/**
 * Run a SELECT for the Analytics agent under least privilege.
 *
 * Every analytics query executes inside a transaction that (1) assumes the
 * SELECT-only `analytics` role, (2) is marked transaction_read_only, and
 * (3) has a hard statement/lock timeout. This is the enforcement that makes the
 * agent's "never write/delete" guarantee physical, not prompt-based: even if a
 * query were malformed or adversarial, the role cannot mutate and the
 * transaction rejects writes.
 *
 * `text` MUST be assembled only from the curated metrics catalog (whitelisted
 * identifiers). Every user-supplied value MUST be passed in `params` as a bound
 * placeholder ($1, $2, …) — never string-interpolated into `text`.
 */
export async function analyticsRead<T = postgres.Row>(
  text: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  const rows = await sql.begin(async tx => {
    await tx`SET LOCAL ROLE analytics`;
    await tx`SET LOCAL transaction_read_only = on`;
    await tx`SET LOCAL statement_timeout = 8000`;
    await tx`SET LOCAL lock_timeout = 2000`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return tx.unsafe(text, params as any[]);
  });
  return rows as unknown as T[];
}

/** Apply backend/migrations/*.sql in filename order, tracked in schema_migrations. */
export async function migrate(): Promise<void> {
  await sql`CREATE TABLE IF NOT EXISTS schema_migrations (
    filename TEXT PRIMARY KEY,
    applied_at TIMESTAMP DEFAULT NOW()
  )`;
  const dir = path.join(process.cwd(), 'migrations');
  if (!existsSync(dir)) {
    console.warn(`[migrate] no migrations directory at ${dir}, skipping`);
    return;
  }
  const files = readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  const applied = new Set((await sql`SELECT filename FROM schema_migrations`).map(r => r.filename as string));
  for (const file of files) {
    if (applied.has(file)) continue;
    const content = readFileSync(path.join(dir, file), 'utf8');
    console.log(`[migrate] applying ${file}`);
    await sql.begin(async tx => {
      await tx.unsafe(content);
      await tx`INSERT INTO schema_migrations (filename) VALUES (${file})`;
    });
  }
}

/** Ensure a cash ("Bargeld") account exists for every user-linked personal account,
 *  so cash payments can be attributed per person — separately from their card/bank
 *  account. Idempotent and crash-safe (must never abort boot). Name is derived by
 *  swapping "Konto"→"Bargeld" (e.g. "Martins Konto" → "Martins Bargeld"); rename in
 *  Admin → Konten if you prefer. */
export async function ensureCashKonten(): Promise<void> {
  try {
    const personal = await sql`
      SELECT id, name, user_id FROM konto
      WHERE user_id IS NOT NULL AND is_shared = FALSE AND is_cash = FALSE
    `;
    for (const k of personal) {
      const [{ has }] = await sql`SELECT EXISTS(SELECT 1 FROM konto WHERE user_id = ${k.user_id} AND is_cash = TRUE) AS has`;
      if (has) continue;
      const swapped = (k.name as string).replace(/Konto/i, 'Bargeld').trim();
      const name = swapped && swapped !== (k.name as string) ? swapped : `${k.name} Bargeld`;
      // account_type 'bargeld' keeps it in lockstep with is_cash (a cash account has no
      // bank statement) — else it would default to 'giro' and mislabel + wrongly trip the
      // receipt-completeness gate for a brand-new cash account.
      await sql`INSERT INTO konto (name, is_shared, is_cash, user_id, account_type) VALUES (${name}, FALSE, TRUE, ${k.user_id}, 'bargeld')`;
      console.log(`[seed] created cash account "${name}" for user ${k.user_id}`);
    }
  } catch (err) {
    console.warn('[seed] ensureCashKonten skipped:', (err as Error).message);
  }
}

/** Seed/repair the admin user.
 *  - Creates "martin" if no admin user exists yet.
 *  - ADMIN_RESET=true forces a password reset for "martin" (recovery switch).
 *  - ADMIN_PASSWORD overrides the default initial password. */
export async function ensureAdmin(): Promise<void> {
  const password = process.env.ADMIN_PASSWORD ?? 'vorrat-start-2026';
  const force = process.env.ADMIN_RESET === 'true';

  const martin = await sql`SELECT id, is_admin FROM users WHERE username = 'martin'`;

  if (martin.length) {
    if (force) {
      const hash = await bcrypt.hash(password, 12);
      // Recovery switch: reset the password only. Do NOT touch sees_all_konten here —
      // an admin may have deliberately demoted themselves, and a password reset must
      // not silently re-escalate super-admin visibility.
      await sql`UPDATE users SET password_hash = ${hash}, is_admin = TRUE WHERE username = 'martin'`;
      console.log('[seed] ADMIN_RESET: password for "martin" has been reset');
    } else {
      console.log('[seed] admin user "martin" exists');
    }
    return;
  }

  const [{ count }] = await sql`SELECT COUNT(*)::int AS count FROM users WHERE is_admin = TRUE`;
  if (count > 0 && !force) {
    console.log(`[seed] ${count} admin user(s) exist, not seeding "martin"`);
    return;
  }

  const hash = await bcrypt.hash(password, 12);
  await sql`INSERT INTO users (username, password_hash, is_admin, sees_all_konten) VALUES ('martin', ${hash}, TRUE, TRUE)`;
  console.log('[seed] created admin user "martin"');
}
