// Ad-hoc code signature for macOS — free, no Apple Developer account.
//
// ⚠️ MANDATORY on Apple Silicon, not cosmetic. The arm64 kernel refuses to execute code without a
// valid signature, and the Finder reports that refusal as "is damaged and can't be opened. You
// should move it to the Trash." — which reads like a corrupt download and sent every Mac user
// straight to the bin. It is NOT the notarisation warning; a correctly signed but un-notarised app
// says "Apple could not verify…" and can be allowed through. Ours said damaged, every time, on
// every version, because it carried no signature at all.
//
// Why a hook instead of a config flag: electron-builder 25.x has no ad-hoc path. `identity: "-"`
// only works from 26.x — in 25.1.8 it searches the keychain for a certificate literally named "-",
// finds none, and skips signing (macPackager.js:209 `if (!options.sign && identity == null)`).
// Setting `mac.sign` is what steps around that branch: electron-builder then calls us with exactly
// the options it would have passed to @electron/osx-sign itself — entitlements, hardened runtime,
// the binary list — and we supply only the identity it could not find.
//
// opts.identity is preserved: if a real Developer ID certificate ever shows up here, this hook
// signs with it and the ad-hoc crutch falls away by itself. On a bump to electron-builder 26.x,
// delete this file and use the native option instead, or the app gets signed twice.
import { signAsync } from '@electron/osx-sign';

export default async function adhocSign(opts) {
  const identity = opts.identity || '-';
  // ⚠️ Retry ourselves. electron-builder wraps its OWN signing in retry(…, 3, 5000, 5000); the
  // custom-sign path skips that entirely. Signing here seals ~180 MB of extraResources (asar is
  // off), so a transient failure on a busy runner is a real possibility and would otherwise fail
  // the whole release.
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await signAsync({ ...opts, identity });
    } catch (e) {
      lastError = e;
      console.log(`ad-hoc signing attempt ${attempt} failed: ${e?.message ?? e}`);
      if (attempt < 3) await new Promise(r => setTimeout(r, 5000));
    }
  }
  throw lastError;
}
