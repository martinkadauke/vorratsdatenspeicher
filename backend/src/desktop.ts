import { readFileSync } from 'node:fs';
import path from 'node:path';

// Facts about the Electron build, shared by the routes and by link building.
//
// Only the desktop shell sets DESKTOP_DIR — its presence IS the "am I the desktop app?" test, and
// the directory is the shell↔backend bridge (request files in, status files out).

export const DESKTOP_DIR = process.env.DESKTOP_DIR || '';
export const isDesktop = (): boolean => DESKTOP_DIR !== '';

/** A file the shell wrote into the bridge directory, or null. Never throws: a missing or
 *  half-written file just means "the shell hasn't said anything about this yet". */
export function readBridgeFile<T = Record<string, unknown>>(name: string): T | null {
  if (!DESKTOP_DIR) return null;
  try {
    const v = JSON.parse(readFileSync(path.join(DESKTOP_DIR, name), 'utf8'));
    return v && typeof v === 'object' ? (v as T) : null;
  } catch { return null; }
}

/**
 * The address this instance is actually reachable at — the base of every link we put in an e-mail.
 *
 * ⚠️ This is why the desktop build's password-reset mail was broken: `app.base_url` is a SETTING,
 * and on a machine nobody configures it stayed empty, so the link came out as a bare
 * "/reset?token=…" that no mail client can open. A desktop instance always knows its own address,
 * so it should never have had to be told. Prefer the public tunnel host (works from the phone the
 * mail is read on); fall back to the loopback URL, which at least works in the browser on this
 * very machine.
 */
export function desktopBaseUrl(): string {
  if (!DESKTOP_DIR) return '';
  const tunnel = readBridgeFile<{ state?: string; url?: string }>('tunnel-status.json');
  if (tunnel?.state === 'up' && tunnel.url) return tunnel.url.replace(/\/$/, '');
  const port = process.env.PORT;
  return port ? `http://127.0.0.1:${port}` : '';
}
