// The self-install decisions, exercised without a Mac, a disk image or a packaged app.
//
// Worth a test because both functions are all edge case: every branch is "which of these folders
// is this, and may I write to it", the wrong answer either skips the install silently or targets a
// path the user cannot write, and none of it is visible until someone double-clicks a DMG.
import assert from 'node:assert/strict';
import { shouldSelfInstall, chooseInstallTarget, bundlePathFromExecPath } from '../selfInstall.mjs';

const HOME = '/Users/martin';
const APP = 'Vorratsdatenspeicher Desktop.app';
const base = { isPackaged: true, platform: 'darwin', homeDir: HOME };

const should = [
  ['from the mounted disk image', `/Volumes/Vorratsdatenspeicher 0.40.0/${APP}`, true],
  ['from Downloads', `${HOME}/Downloads/${APP}`, true],
  ['already in /Applications', `/Applications/${APP}`, false],
  ['already in ~/Applications', `${HOME}/Applications/${APP}`, false],
  ['inside a subfolder of /Applications', `/Applications/Utilities/${APP}`, false],
  // "/Applications Extra" is NOT "/Applications" — a prefix test without the separator says it is,
  // and the app would then never install itself for anyone with such a folder.
  ['in a folder merely starting with /Applications', `/Applications Extra/${APP}`, true],
  ['not a bundle path', '/Volumes/VDS/vorratsdatenspeicher', false],
];
for (const [name, bundlePath, expected] of should) {
  assert.equal(shouldSelfInstall({ ...base, bundlePath }), expected, `shouldSelfInstall: ${name}`);
}
assert.equal(shouldSelfInstall({ ...base, isPackaged: false, bundlePath: `/Volumes/x/${APP}` }), false, 'dev run');
assert.equal(shouldSelfInstall({ ...base, platform: 'win32', bundlePath: `/Volumes/x/${APP}` }), false, 'not macOS');
assert.equal(shouldSelfInstall({ ...base, platform: 'linux', bundlePath: `/Volumes/x/${APP}` }), false, 'not macOS');

assert.equal(bundlePathFromExecPath(`/Applications/${APP}/Contents/MacOS/Vorratsdatenspeicher Desktop`),
  `/Applications/${APP}`, 'exe path → bundle path');

const target = (o) => chooseInstallTarget({ bundleName: APP, homeDir: HOME, ...o });
const SYS = `/Applications/${APP}`;
const USR = `${HOME}/Applications/${APP}`;

assert.deepEqual(target({ systemExists: false, userExists: false, systemWritable: true }),
  { path: SYS, existingInstall: false }, 'fresh install goes to /Applications');
assert.deepEqual(target({ systemExists: false, userExists: false, systemWritable: false }),
  { path: USR, existingInstall: false }, 'no admin rights → ~/Applications');
assert.deepEqual(target({ systemExists: true, userExists: false, systemWritable: true }),
  { path: SYS, existingInstall: true }, 'replaces the copy in /Applications');
// The important one: an admin-owned copy this user cannot touch must never be targeted — that
// replace is a guaranteed permission error. Their own copy is used and the admin one is left alone.
assert.deepEqual(target({ systemExists: true, userExists: true, systemWritable: false }),
  { path: USR, existingInstall: true }, 'unwritable /Applications copy is not targeted');
assert.deepEqual(target({ systemExists: true, userExists: false, systemWritable: false }),
  { path: USR, existingInstall: false }, 'unwritable /Applications copy → fresh user install');
assert.deepEqual(target({ systemExists: false, userExists: true, systemWritable: true }),
  { path: USR, existingInstall: true }, 'updates the copy they actually use');

console.log(`[selfinstall] OK — ${should.length + 9} decisions hold`);
