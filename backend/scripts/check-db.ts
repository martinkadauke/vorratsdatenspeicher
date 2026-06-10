/** Read-only database inspection — verifies what exists, changes nothing.
 *  Run from backend/:  npx tsx scripts/check-db.ts  (uses .env) */
import '../src/env.js';
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL!, { onnotice: () => {} });

const tables = await sql`
  SELECT table_name FROM information_schema.tables
  WHERE table_schema = 'public' ORDER BY table_name
`;
console.log('Tabellen:', tables.map(t => t.table_name).join(', '));

const [einkauf] = await sql`SELECT COUNT(*)::int AS n, MAX(datum)::text AS last FROM einkauf`;
const [artikel] = await sql`SELECT COUNT(*)::int AS n FROM artikel`;
const [catPath] = await sql`SELECT COUNT(*)::int AS n FROM artikel WHERE category_path IS NOT NULL`;
console.log(`einkauf: ${einkauf.n} Zeilen (letzter: ${einkauf.last})`);
console.log(`artikel: ${artikel.n} Zeilen, davon ${catPath.n} mit category_path`);

const users = await sql`SELECT id, username, email, is_admin, created_at FROM users ORDER BY id`;
console.log('users:');
for (const u of users) {
  console.log(`  #${u.id} ${u.username} ${u.email ?? '(keine email)'} admin=${u.is_admin} angelegt=${u.created_at}`);
}

const migrations = await sql`SELECT filename, applied_at FROM schema_migrations ORDER BY filename`;
console.log('Migrationen:', migrations.map(m => m.filename).join(', '));

await sql.end();
