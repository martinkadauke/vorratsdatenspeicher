/** Minimal .env loader (no dependency). Real env vars take precedence. */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const envPath = path.join(process.cwd(), '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  console.log(`[env] loaded ${envPath}`);
}
