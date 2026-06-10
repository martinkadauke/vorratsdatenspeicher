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

/** Seed the initial admin user if the users table is empty. */
export async function ensureAdmin(): Promise<void> {
  const [{ count }] = await sql`SELECT COUNT(*)::int AS count FROM users`;
  if (count > 0) return;
  const password = process.env.ADMIN_PASSWORD ?? 'vorrat-start-2026';
  const hash = await bcrypt.hash(password, 12);
  await sql`INSERT INTO users (username, password_hash, is_admin) VALUES ('martin', ${hash}, TRUE)`;
  console.log('[seed] created admin user "martin"');
}
