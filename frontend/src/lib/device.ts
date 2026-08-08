/** What KIND of thing is this page running in?
 *
 *  Shared because two features ask the same questions and drifting answers would show: the coach
 *  decides whether "put VDS on your phone" is worth saying, and the install prompt decides whether
 *  it can be acted on here. */

/** Running as an installed PWA (home-screen icon), rather than in a browser tab. */
export function isInstalledPwa(): boolean {
  if (typeof window === 'undefined') return false;
  return !!window.matchMedia?.('(display-mode: standalone)').matches
    || (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
}

/** A touch device at phone size — not a laptop with a touchscreen. */
export function isPhone(): boolean {
  if (typeof window === 'undefined') return false;
  return !!window.matchMedia?.('(pointer: coarse)').matches && window.innerWidth <= 900;
}

/** iOS/iPadOS. They matter on their own because Safari offers NO install API at all: there is
 *  nothing to click, only a place to point. iPadOS reports itself as a Mac, hence the touch test. */
export function isIos(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua)
    || (/Macintosh/.test(ua) && typeof document !== 'undefined' && 'ontouchend' in document);
}

/** Installing a PWA needs a secure context; over plain HTTP the browser offers nothing, so an
 *  invitation to install would be an invitation to fail. Loopback counts as secure. */
export function canInstallHere(): boolean {
  if (typeof window === 'undefined') return false;
  return window.isSecureContext === true;
}
