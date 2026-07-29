import {
  ReceiptText, ShoppingCart, Boxes,
  Settings, UserCircle, Wallet, Building2, type LucideIcon,
} from 'lucide-react';

export interface NavItem { to: string; icon: LucideIcon; key: string }

// Single source of truth for nav order. The first MOBILE_PRIMARY items also form
// the mobile bottom bar; the rest live under "Mehr" on mobile and inline on desktop.
// Shopping is a HUB (Liste / Angebote / Läden tabs) — see pages/ShoppingHub.tsx.
// Statistik is gone as its own entry: it was folded into Finanzen (/stats redirects
// there), so the category tree, the goals and the plans are one page now.
export const NAV: NavItem[] = [
  { to: '/receipts',   icon: ReceiptText,  key: 'nav.receipts' },     // belege (Startseite)
  { to: '/shopping',   icon: ShoppingCart, key: 'nav.einkauf' },      // Einkauf-Hub: Liste / Angebote / Läden
  { to: '/warenstamm', icon: Boxes,        key: 'nav.warenstamm' },   // artikel/positionen/vorrat/prüfen
  { to: '/finanzen',   icon: Wallet,       key: 'nav.finanzen' },     // statistik / fixkosten / einkommen / ziele
];

// Mobile bottom bar = all four (Receipts, Shopping, Master-data, Finanzen); only
// navExtras live under "Mehr".
export const MOBILE_PRIMARY = 4;

/** Tail items after the main nav: admin (admins), households (super-admin only, demo), then
 *  profile. Sourced here so BOTH the desktop sidebar and the mobile "More" page get them.
 *  isSuper is always false off-demo, so the households entry only appears on the demo. */
export function navExtras(isAdmin: boolean, isSuper = false): NavItem[] {
  // Order matters: on mobile, "More" now shows only these → Households, Admin, Profile
  // (NAV fits the bottom bar exactly). isSuper is always false off-demo, so Households
  // only shows on the demo.
  return [
    ...(isSuper ? [{ to: '/admin/households', icon: Building2, key: 'nav.households' }] : []),
    ...(isAdmin ? [{ to: '/admin', icon: Settings, key: 'nav.admin' }] : []),
    { to: '/profile', icon: UserCircle, key: 'nav.profile' },
  ];
}
