import {
  ReceiptText, ShoppingCart, Boxes,
  Settings, UserCircle, Wallet, type LucideIcon,
} from 'lucide-react';

export interface NavItem { to: string; icon: LucideIcon; key: string }

// Single source of truth for nav order. These four are the content nav: they fill the
// desktop sidebar and the first four slots of the mobile bottom bar.
// Shopping is a HUB (Liste / Angebote / Läden tabs) — see pages/ShoppingHub.tsx.
// Statistik is gone as its own entry: it was folded into Finanzen (/stats redirects
// there), so the category tree, the goals and the plans are one page now.
export const NAV: NavItem[] = [
  { to: '/receipts',   icon: ReceiptText,  key: 'nav.receipts' },     // belege (Startseite)
  { to: '/shopping',   icon: ShoppingCart, key: 'nav.einkauf' },      // Einkauf-Hub: Liste / Angebote / Läden
  { to: '/warenstamm', icon: Boxes,        key: 'nav.warenstamm' },   // artikel/positionen/vorrat/prüfen
  { to: '/finanzen',   icon: Wallet,       key: 'nav.finanzen' },     // statistik / fixkosten / einkommen / ziele
];

// The mobile bottom bar shows all of NAV plus exactly one tail slot (mobileTail) —
// five in total. There is no "Mehr" page any more; nothing is parked behind one.
export const MOBILE_PRIMARY = NAV.length;

/** The fifth bottom-bar slot. The OPERATOR gets Admin — the one place they actually need to
 *  reach in one tap; everyone else gets Profil, which is where their own settings live
 *  (dark mode, language, password, push) and, at the bottom of it, Abmelden.
 *
 *  Keyed on the operator predicate (`demo ? is_super_admin : is_admin`, the frontend twin of
 *  requireOperator), NOT on is_admin: on the demo every signup user is is_admin of their own
 *  household (auth/routes.ts), so an is_admin test hands the Admin tab to literally every
 *  visitor — and hands NO ONE Profil, burying log-out behind the unlabeled header avatar.
 *  Off-demo both sides of the predicate are is_admin, so self-hosters are unchanged. */
export function mobileTail(isOperator: boolean): NavItem {
  return isOperator
    ? { to: '/admin', icon: Settings, key: 'nav.admin' }
    : { to: '/profile', icon: UserCircle, key: 'nav.profile' };
}

/** Tail items after the main nav in the DESKTOP sidebar: admin (admins), then profile.
 *  Haushalte is deliberately absent — it is a section inside the Admin page now, so the
 *  super-admin reaches it there instead of via a nav entry that only exists on the demo. */
export function navExtras(isAdmin: boolean): NavItem[] {
  return [
    ...(isAdmin ? [{ to: '/admin', icon: Settings, key: 'nav.admin' }] : []),
    { to: '/profile', icon: UserCircle, key: 'nav.profile' },
  ];
}
