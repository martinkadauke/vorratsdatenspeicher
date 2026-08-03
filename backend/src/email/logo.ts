import { readFileSync, existsSync } from 'fs';
import path from 'path';

/** The VDS mark in outbound mail, as an INLINE (CID) attachment rather than a hotlinked URL.
 *
 *  Hotlinking `${base_url}/icon-192.png` cannot work for the typical self-hoster: Gmail and
 *  Outlook do not fetch <img> from the recipient's browser, they proxy it server-side
 *  (googleusercontent.com/proxy/…). A base_url pointing at an RFC1918 address — which is what
 *  a box on someone's LAN has — is unreachable from those proxies, so the mark silently
 *  collapsed to an empty box. Embedding the bytes in the message removes the network entirely:
 *  it renders on LAN, off LAN, and air-gapped.
 *
 *  A data: URI is NOT an alternative — Gmail strips data-URI images outright.
 *
 *  Resolved once at first use. If the file is not there (backend running from source with no
 *  built frontend), hasEmailLogo() reports false and the templates keep their text fallback,
 *  so a dev box never mails a broken image. */
export const LOGO_CID = 'vdslogo';

const CANDIDATES = [
  // Container: Dockerfile copies frontend/dist → ./public next to dist/.
  () => path.join(process.cwd(), 'public', 'icon-192.png'),
  // Dev: backend runs with cwd=backend/, the asset is still in the frontend source tree.
  () => path.join(process.cwd(), '..', 'frontend', 'public', 'icon-192.png'),
];

let cached: string | null | undefined;   // undefined = not looked yet, null = looked and absent

function load(): string | null {
  if (cached !== undefined) return cached;
  cached = null;
  for (const c of CANDIDATES) {
    try {
      const p = c();
      if (existsSync(p)) { cached = readFileSync(p).toString('base64'); break; }
    } catch { /* unreadable candidate is just a miss */ }
  }
  return cached;
}

/** Whether templates may reference `cid:vdslogo` — false means fall back to text. */
export function hasEmailLogo(): boolean {
  return load() !== null;
}

/** The nodemailer attachment for the mark, or null when the asset is unavailable.
 *  The mailer adds this itself whenever the HTML actually references the CID. */
export function emailLogoAttachment(): { filename: string; content: string; encoding: 'base64'; contentType: string; cid: string } | null {
  const b64 = load();
  if (!b64) return null;
  return { filename: 'vds.png', content: b64, encoding: 'base64', contentType: 'image/png', cid: LOGO_CID };
}
