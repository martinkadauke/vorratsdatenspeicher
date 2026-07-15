import {
  ReceiptText, ShoppingCart, Boxes,
  ChartPie, Settings, UserCircle, Wallet, Building2, type LucideIcon,
} from 'lucide-react';

export interface NavItem { to: string; icon: LucideIcon; key: string }

// Single source of truth for nav order. The first MOBILE_PRIMARY items also form
// the mobile bottom bar; the rest live under "Mehr" on mobile and inline on desktop.
// Shopping is a HUB (Liste / Angebote / Läden tabs) — see pages/ShoppingHub.tsx.
export const NAV: NavItem[] = [
  { to: '/receipts',   icon: ReceiptText,  key: 'nav.receipts' },     // belege (Startseite)
  { to: '/shopping',   icon: ShoppingCart, key: 'nav.einkauf' },      // Einkauf-Hub: Liste / Angebote / Läden
  { to: '/warenstamm', icon: Boxes,        key: 'nav.warenstamm' },   // artikel/positionen/vorrat/prüfen
  { to: '/stats',      icon: ChartPie,     key: 'nav.stats' },        // statistik
  { to: '/finanzen',   icon: Wallet,       key: 'nav.finanzen' },     // fixkosten / einkommen / budgets
];

// Mobile bottom bar = the first 4 (Receipts, Shopping, Master-data, Stats); the rest
// (Finanzen + navExtras) live under "Mehr".
export const MOBILE_PRIMARY = 4;

/** Tail items after the main nav: admin (admins), households (super-admin only, demo), then
 *  profile. Sourced here so BOTH the desktop sidebar and the mobile "More" page get them.
 *  isSuper is always false off-demo, so the households entry only appears on the demo. */
export function navExtras(isAdmin: boolean, isSuper = false): NavItem[] {
  // Order matters: on mobile, "More" shows Finanzen (from NAV) then these → Households,
  // Admin, Profile. isSuper is always false off-demo, so Households only shows on the demo.
  return [
    ...(isSuper ? [{ to: '/admin/households', icon: Building2, key: 'nav.households' }] : []),
    ...(isAdmin ? [{ to: '/admin', icon: Settings, key: 'nav.admin' }] : []),
    { to: '/profile', icon: UserCircle, key: 'nav.profile' },
  ];
}
