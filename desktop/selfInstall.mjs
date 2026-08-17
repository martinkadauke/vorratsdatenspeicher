// The install contract for the macOS disk image: the user double-clicks VDS inside the mounted
// image and it puts ITSELF into Applications, then relaunches from there. No drag-and-drop target,
// no instructions to follow — the step people skip, and then run the app from the disk image
// forever, wondering why it vanishes when they eject it.
//
// This costs nothing and needs no certificate. It is deliberately separate from the "Apple could
// not verify…" dialog, which is the absence of notarization and can only be removed by paying
// Apple; a self-installing app still shows it once. One is a convenience we can give away, the
// other is not ours to give.
//
// The decisions are pure functions so they can be exercised without a Mac, a disk image, or a
// packaged app — everything below the line does no I/O.
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { constants as FS } from 'node:fs';
// ⚠️ POSIX path arithmetic throughout: this module only ever runs on macOS, and using the
// platform's own separator would make its decisions untestable anywhere else — path.sep is a
// backslash on the machine most of this is developed on, so `/Applications/` would never match.
import nodePath from 'node:path';
const path = nodePath.posix;
import os from 'node:os';
import { promisify } from 'node:util';

const run = promisify(execFile);

export const SYSTEM_APPLICATIONS = '/Applications';

/** <bundle>.app/Contents/MacOS/<binary> → <bundle>.app */
export function bundlePathFromExecPath(execPath) {
  return path.resolve(execPath, '..', '..', '..');
}

/**
 * Only when there is something to gain: a packaged Mac app that is running from somewhere other
 * than an Applications folder — which in practice means the mounted disk image. Running from a
 * Downloads folder counts too, and moving it there is just as much of an improvement.
 */
export function shouldSelfInstall({ isPackaged, platform, bundlePath, homeDir }) {
  if (!isPackaged || platform !== 'darwin') return false;
  if (!bundlePath.endsWith('.app')) return false;          // not a bundle layout — don't guess
  const userApplications = path.join(homeDir, 'Applications');
  return ![SYSTEM_APPLICATIONS, userApplications]
    .some(dir => bundlePath === dir || bundlePath.startsWith(`${dir}${path.sep}`));
}

/**
 * Where to install, decided from observed facts only.
 *
 * /Applications is the right home and wins whenever we can actually write there. A copy sitting in
 * /Applications that this user cannot replace is never targeted — that would be a guaranteed
 * permission error — so their own ~/Applications is used instead and the admin-owned copy is left
 * alone. Nothing is ever deleted; replacing means overwriting the one we chose.
 */
export function chooseInstallTarget({ bundleName, homeDir, systemExists, userExists, systemWritable }) {
  const systemPath = path.join(SYSTEM_APPLICATIONS, bundleName);
  const userPath = path.join(homeDir, 'Applications', bundleName);
  if (systemExists && systemWritable) return { path: systemPath, existingInstall: true };
  if (userExists) return { path: userPath, existingInstall: true };
  if (systemWritable) return { path: systemPath, existingInstall: false };
  return { path: userPath, existingInstall: false };
}

// ── everything below touches the disk ────────────────────────────────────────────────────────

const exists = async (p) => { try { await fs.access(p); return true; } catch { return false; } };
const writable = async (p) => { try { await fs.access(p, FS.W_OK); return true; } catch { return false; } };

/**
 * Install this bundle into Applications and relaunch from there.
 *
 * @returns true when the caller must stop starting up — a copy is now running from Applications.
 */
export async function selfInstall({ app, dialog, log = () => {} }) {
  const bundlePath = bundlePathFromExecPath(app.getPath('exe'));
  if (!shouldSelfInstall({
    isPackaged: app.isPackaged, platform: process.platform, bundlePath, homeDir: os.homedir(),
  })) return false;

  const bundleName = path.basename(bundlePath);
  const target = chooseInstallTarget({
    bundleName,
    homeDir: os.homedir(),
    systemExists: await exists(path.join(SYSTEM_APPLICATIONS, bundleName)),
    userExists: await exists(path.join(os.homedir(), 'Applications', bundleName)),
    systemWritable: await writable(SYSTEM_APPLICATIONS),
  });

  // Replacing someone's existing install is their decision, not ours. A fresh install is silent:
  // there is nothing to lose and nothing to decide.
  if (target.existingInstall) {
    const { response } = await dialog.showMessageBox({
      type: 'question',
      buttons: ['Ersetzen', 'Vorhandene Version öffnen'],
      defaultId: 0,
      cancelId: 1,
      message: 'Vorratsdatenspeicher ist bereits installiert.',
      detail: `Soll die Version in ${path.dirname(target.path)} durch diese ersetzt werden?\n\n`
        + 'Deine Daten bleiben in beiden Fällen erhalten — sie liegen nicht in der App.',
    });
    if (response !== 0) {
      log('self-install declined — launching the existing installation');
      await relaunch(target.path, app, log);
      return true;
    }
  }

  try {
    await fs.mkdir(path.dirname(target.path), { recursive: true });
    // ditto, not cp: it is the tool that copies an .app faithfully — extended attributes, symlinks
    // and the code signature's own layout included. A signature that survives the copy is the whole
    // point, since a broken one is exactly the "damaged, move it to the Trash" dialog.
    await run('ditto', [bundlePath, target.path]);
  } catch (e) {
    log(`self-install failed: ${String(e?.message ?? e).slice(0, 200)}`);
    await dialog.showMessageBox({
      type: 'warning',
      message: 'Vorratsdatenspeicher konnte sich nicht selbst installieren.',
      detail: `Bitte ziehe die App von Hand in den Ordner „Programme".\n\n${String(e?.message ?? e).slice(0, 300)}`,
    });
    return false;         // let it run from where it is rather than leaving the user with nothing
  }

  // The user opened this app deliberately — they got past Gatekeeper to do it. The copy inherits
  // the download quarantine flag, so without this they would be asked to approve the very same
  // app a second time, one folder later. Their decision is not re-litigated; it is carried over.
  try { await run('xattr', ['-dr', 'com.apple.quarantine', target.path]); } catch { /* nothing to clear */ }

  log(`installed to ${target.path} — relaunching from there`);
  await relaunch(target.path, app, log);
  return true;
}

async function relaunch(appPath, app, log) {
  // ⚠️ Release the single-instance lock FIRST. We are still holding it, and the copy we are about
  // to start asks for the same one — it would lose, quit itself, and leave the user with an app
  // that installed itself and then refused to open. The lock protects against a second Postgres
  // on one data directory; here we are handing over, not competing.
  try { app.releaseSingleInstanceLock?.(); } catch { /* not held */ }
  try {
    await run('open', ['-n', appPath]);
  } catch (e) {
    log(`could not relaunch from ${appPath}: ${String(e?.message ?? e).slice(0, 160)}`);
  }
}
