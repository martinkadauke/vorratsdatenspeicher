import postgres from 'postgres';
import { AsyncLocalStorage } from 'node:async_hooks';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import bcrypt from 'bcryptjs';

/**
 * DEMO_MODE splits this file into two worlds:
 *  - OFF (dev / prod / the public container): a single plain pool, no RLS, no household
 *    scoping — byte-for-byte the original single-household app.
 *  - ON (demo.vorratsdatenspeicher.com): the multi-tenant layer — a non-owner runtime role
 *    (vds_app) whose every query is RLS-scoped to app.current_household, plus an owner
 *    (adminSql) lane for migrations + cross-household platform ops.
 * Everything demo-only below is defined unconditionally but only ever CALLED from
 * DEMO_MODE-gated code (index.ts boot, the auth plugin), so it's inert when the flag is off.
 */
export const DEMO_MODE = process.env.DEMO_MODE === 'true';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/vorratsdatenspeicher';
// Owner/admin connection (demo: migrations + cross-household ops; single-URL → same conn).
const ADMIN_DATABASE_URL = process.env.ADMIN_DATABASE_URL ?? DATABASE_URL;
// TimeZone is pinned per CONNECTION, not left to the server. The box this app happens to
// land on decides `SHOW TimeZone` otherwise — the owner's own Postgres reports
// America/Los_Angeles, so NOW() ran nine hours behind the household using it, and a
// self-hoster's server could say anything at all. Pinning it here makes every install
// deterministic and travels with the code instead of living in someone's postgresql.conf.
// Matches the container's TZ (see Dockerfile) so JS and SQL agree on when "today" ends.
// Only affects how TIMESTAMPTZ is rendered and what NOW() returns; nothing stored is rewritten.
const PG_TZ = process.env.PGTZ ?? 'Europe/Berlin';
const PG_OPTS = {
  onnotice: () => {},
  transform: { undefined: null },
  connection: { TimeZone: PG_TZ },
} as const;

// Off-demo defaults to postgres.js's original max (10) — byte-equivalent to the pre-demo app.
// Demo runs larger: openHousehold() reserves a connection per in-flight request.
const pool = postgres(DATABASE_URL, { ...PG_OPTS, max: Number(process.env.DB_POOL_MAX ?? (DEMO_MODE ? 20 : 10)) });
export type TenantConn = typeof pool;
type Sql = TenantConn;

// Owner lane. Demo: a separate owner connection (bypasses RLS). Non-demo: just the pool.
export const adminSql: Sql = DEMO_MODE
  ? postgres(ADMIN_DATABASE_URL, { ...PG_OPTS, max: Number(process.env.DB_ADMIN_POOL_MAX ?? 4) })
  : pool;

// Per-request household connection (demo only), threaded via AsyncLocalStorage.
export const tenantContext = new AsyncLocalStorage<{ conn: Sql }>();
const active = (): Sql => tenantContext.getStore()?.conn ?? pool;

// Demo default handle: a Proxy that routes every query to the request's household-scoped
// connection (fail-closed RLS). Non-demo uses the plain pool — identical to the original app.
const demoSql: Sql = new Proxy(pool, {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  apply(_t, _this, args: any[]) { return (active() as any)(...args); },
  get(_t, prop) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c = active() as any;
    // postgres.js reserved connections don't expose `.begin` at runtime (the ReservedSql
    // type lies) → synthesize a manual tx pinned to the same reserved conn so it keeps the
    // household's session GUC. With no tenant context c === pool (has begin) → falls through.
    if (prop === 'begin' && typeof c.begin !== 'function') {
      return async (arg: unknown, maybeFn?: unknown) => {
        const fn = (typeof arg === 'function' ? arg : maybeFn) as (tx: Sql) => Promise<unknown>;
        await c`BEGIN`;
        try {
          const result = await fn(c as Sql);
          await c`COMMIT`;
          return result;
        } catch (e) {
          try { await c`ROLLBACK`; } catch { /* connection may already be gone */ }
          throw e;
        }
      };
    }
    const v = c[prop];
    return typeof v === 'function' ? v.bind(c) : v;
  },
}) as Sql;

const sql: Sql = DEMO_MODE ? demoSql : pool;
export default sql;

// ── Demo-only tenant helpers (inert when DEMO_MODE is off; never called then) ──────────
/** Reserve a pooled connection and pin it to `householdId` (session GUC). Caller MUST
 *  pass it to `closeHousehold` to reset + release. */
export async function openHousehold(householdId: number): Promise<Sql> {
  const conn = (await pool.reserve()) as unknown as Sql;
  await conn`SELECT set_config('app.current_household', ${String(householdId)}, false)`;
  return conn;
}
export async function closeHousehold(conn: Sql): Promise<void> {
  try { await conn`SELECT set_config('app.current_household', '', false)`; } catch { /* gone */ }
  (conn as unknown as { release: () => void }).release();
}
export async function withHousehold<T>(householdId: number, fn: () => Promise<T>): Promise<T> {
  const conn = await openHousehold(householdId);
  try { return await tenantContext.run({ conn }, fn); }
  finally { await closeHousehold(conn); }
}
export async function forEachHousehold(fn: (householdId: number) => Promise<void>): Promise<void> {
  const households = await adminSql`SELECT id FROM household ORDER BY id`;
  for (const { id } of households) await withHousehold(id as number, () => fn(id as number));
}
/**
 * Boot interlock (demo only): refuse to start unless the database is a genuine multi-tenant
 * DEMO database. A real demo uses a TWO-ROLE topology — migrations/RLS run as a distinct owner
 * (ADMIN_DATABASE_URL) while the runtime connects as the RLS-scoped non-owner role `vds_app`
 * (DATABASE_URL). A single-role dev/prod database has neither, so this catches the one
 * catastrophic misconfiguration (DEMO_MODE=true pointed at DATABASE_URL_DEV/prod, which would
 * apply the demo migrations and silently RLS-poison the shared DB, starving analytics/n8n).
 * Called before migrate() so nothing is applied when the target looks wrong.
 */
export function assertDemoDb(): void {
  const parseUser = (u: string): string => { try { return decodeURIComponent(new URL(u).username); } catch { return ''; } };
  if (ADMIN_DATABASE_URL === DATABASE_URL || !process.env.ADMIN_DATABASE_URL) {
    throw new Error(
      '[demo guard] DEMO_MODE=true requires a distinct owner ADMIN_DATABASE_URL (for migrations + RLS) '
      + 'separate from the non-owner runtime DATABASE_URL. This DB looks single-role (dev/prod) — refusing to start '
      + 'so the demo migrations never enable RLS on it.',
    );
  }
  const runtimeUser = parseUser(DATABASE_URL);
  if (runtimeUser !== 'vds_app') {
    throw new Error(
      `[demo guard] DEMO_MODE=true requires the runtime DATABASE_URL to connect as the RLS-scoped non-owner `
      + `role 'vds_app' (got '${runtimeUser || 'unknown'}'). Refusing to start against a non-demo database.`,
    );
  }
}

/** Set the vds_app role's password (created without one by migration 089). Demo only. */
export async function ensureAppRole(): Promise<void> {
  const pw = process.env.VDS_APP_PASSWORD;
  if (!pw) return;
  await adminSql.unsafe(`ALTER ROLE vds_app WITH LOGIN PASSWORD '${pw.replace(/'/g, "''")}'`);
  console.log('[boot] vds_app runtime role password set');
}
/** Boot invariant (demo): refuse to start if any household_id table lacks RLS + policy. */
export async function assertRlsCoverage(): Promise<void> {
  const missing = await adminSql`
    SELECT c.relname
    FROM information_schema.columns col
    JOIN pg_class c ON c.relname = col.table_name AND c.relkind = 'r'
    JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
    WHERE col.table_schema = 'public' AND col.column_name = 'household_id'
      AND (NOT c.relrowsecurity
           OR NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation'))
    ORDER BY c.relname`;
  if (missing.length) {
    throw new Error(`[RLS invariant] tenant tables missing RLS/policy: ${missing.map(r => r.relname as string).join(', ')} — refusing to start`);
  }
  console.log('[RLS invariant] all household_id tables have RLS + tenant_isolation policy ✓');
}

/**
 * Analytics agent SELECT under least privilege: SELECT-only read-only `analytics` role with
 * hard timeouts. `text` must come from the curated catalog; user values go in `params`.
 */
export async function analyticsRead<T = postgres.Row>(text: string, params: readonly unknown[] = []): Promise<T[]> {
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

/** Apply migrations/*.sql (always) + migrations/demo/*.sql (DEMO_MODE only), filename order,
 *  tracked in schema_migrations. Runs on the owner connection (adminSql). */
export async function migrate(): Promise<void> {
  await adminSql`CREATE TABLE IF NOT EXISTS schema_migrations (
    filename TEXT PRIMARY KEY,
    applied_at TIMESTAMP DEFAULT NOW()
  )`;
  const dir = path.join(process.cwd(), 'migrations');
  if (!existsSync(dir)) {
    console.warn(`[migrate] no migrations directory at ${dir}, skipping`);
    return;
  }
  // Core migrations run everywhere. Multi-tenant migrations (migrations/demo/) run ONLY in
  // DEMO_MODE — enabling RLS on dev/prod would starve the non-owner analytics/n8n roles.
  const core = readdirSync(dir).filter(f => f.endsWith('.sql')).map(f => ({ file: f, full: path.join(dir, f) }));
  const demoDir = path.join(dir, 'demo');
  // Demo migrations tracked by BASENAME (e.g. "086_household.sql") — matches how the existing
  // demo DB already recorded them, so a cutover to this code doesn't try to re-apply them.
  const demo = DEMO_MODE && existsSync(demoDir)
    ? readdirSync(demoDir).filter(f => f.endsWith('.sql')).map(f => ({ file: f, full: path.join(demoDir, f) }))
    : [];
  const files = [...core, ...demo].sort((a, b) => a.file.localeCompare(b.file));
  const applied = new Set((await adminSql`SELECT filename FROM schema_migrations`).map(r => r.filename as string));
  for (const { file, full } of files) {
    if (applied.has(file)) continue;
    const content = readFileSync(full, 'utf8');
    console.log(`[migrate] applying ${file}`);
    await adminSql.begin(async tx => {
      await tx.unsafe(content);
      await tx`INSERT INTO schema_migrations (filename) VALUES (${file})`;
    });
  }
}

/** Ensure a cash ("Bargeld") account exists for every user-linked personal account. */
export async function ensureCashKonten(): Promise<void> {
  try {
    const personal = DEMO_MODE
      ? await adminSql`SELECT id, name, user_id, household_id FROM konto WHERE user_id IS NOT NULL AND is_shared = FALSE AND is_cash = FALSE`
      : await adminSql`SELECT id, name, user_id FROM konto WHERE user_id IS NOT NULL AND is_shared = FALSE AND is_cash = FALSE`;
    for (const k of personal) {
      const [{ has }] = await adminSql`SELECT EXISTS(SELECT 1 FROM konto WHERE user_id = ${k.user_id} AND is_cash = TRUE) AS has`;
      if (has) continue;
      const swapped = (k.name as string).replace(/Konto/i, 'Bargeld').trim();
      const name = swapped && swapped !== (k.name as string) ? swapped : `${k.name} Bargeld`;
      if (DEMO_MODE) {
        await adminSql`INSERT INTO konto (name, is_shared, is_cash, user_id, account_type, household_id) VALUES (${name}, FALSE, TRUE, ${k.user_id}, 'bargeld', ${k.household_id})`;
      } else {
        await adminSql`INSERT INTO konto (name, is_shared, is_cash, user_id, account_type) VALUES (${name}, FALSE, TRUE, ${k.user_id}, 'bargeld')`;
      }
      console.log(`[seed] created cash account "${name}" for user ${k.user_id}`);
    }
  } catch (err) {
    console.warn('[seed] ensureCashKonten skipped:', (err as Error).message);
  }
}

/** Seed/repair the admin user. Demo: the household-less platform super-admin (is_super_admin).
 *  Non-demo: the single-household admin (original behaviour). */
export async function ensureAdmin(): Promise<void> {
  const username = process.env.ADMIN_USERNAME ?? 'admin';
  const password = process.env.ADMIN_PASSWORD ?? 'vorrat-start-2026';
  const force = process.env.ADMIN_RESET === 'true';

  if (DEMO_MODE) {
    const email = process.env.ADMIN_EMAIL ?? null;
    const existing = await adminSql`SELECT id FROM users WHERE is_super_admin = TRUE`;
    if (existing.length) {
      if (force) {
        const hash = await bcrypt.hash(password, 12);
        await adminSql`UPDATE users SET password_hash = ${hash} WHERE username = ${username}`;
        console.log(`[seed] ADMIN_RESET: password for "${username}" reset`);
      } else {
        console.log('[seed] platform super-admin exists');
      }
      return;
    }
    const hash = await bcrypt.hash(password, 12);
    await adminSql`INSERT INTO users (username, email, password_hash, is_admin, sees_all_konten, is_super_admin, household_id)
                   VALUES (${username}, ${email}, ${hash}, TRUE, TRUE, TRUE, 1)`;
    console.log(`[seed] created platform super-admin "${username}"`);
    return;
  }

  // Non-demo (original single-household behaviour)
  const existing = await sql`SELECT id, is_admin FROM users WHERE username = ${username}`;
  if (existing.length) {
    if (force) {
      const hash = await bcrypt.hash(password, 12);
      await sql`UPDATE users SET password_hash = ${hash}, is_admin = TRUE WHERE username = ${username}`;
      console.log(`[seed] ADMIN_RESET: password for "${username}" has been reset`);
    } else {
      console.log(`[seed] admin user "${username}" exists`);
    }
    return;
  }
  const [{ count }] = await sql`SELECT COUNT(*)::int AS count FROM users WHERE is_admin = TRUE`;
  if (count > 0 && !force) {
    console.log(`[seed] ${count} admin user(s) exist, not seeding "${username}"`);
    return;
  }
  const hash = await bcrypt.hash(password, 12);
  await sql`INSERT INTO users (username, password_hash, is_admin, sees_all_konten) VALUES (${username}, ${hash}, TRUE, TRUE)`;
  console.log(`[seed] created admin user "${username}"`);
}
