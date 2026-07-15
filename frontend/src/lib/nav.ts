import {
  ReceiptText, ShoppingCart, BadgePercent, Boxes, Store,
  ChartPie, Settings, UserCircle, Wallet, Building2, type LucideIcon,
} from 'lucide-react';

export interface NavItem { to: string; icon: LucideIcon; key: string }

// Single source of truth for nav order. The first MOBILE_PRIMARY items also form
// the mobile bottom bar; the rest live under "Mehr" on mobile and inline on desktop.
export const NAV: NavItem[] = [
  { to: '/receipts', icon: ReceiptText, key: 'nav.receipts' },       // belege (Startseite)
  { to: '/shopping', icon: ShoppingCart, key: 'nav.shopping' },      // liste
  { to: '/offers', icon: BadgePercent, key: 'nav.offers' },          // angebote
  { to: '/warenstamm', icon: Boxes, key: 'nav.warenstamm' },         // warenstamm (artikel/positionen/vorrat/prüfen)
  { to: '/stores', icon: Store, key: 'nav.stores' },                 // läden
  { to: '/stats', icon: ChartPie, key: 'nav.stats' },                // statistik
  { to: '/finanzen', icon: Wallet, key: 'nav.finanzen' },            // fixkosten / einkommen / budgets
];

export const MOBILE_PRIMARY = 4;

/** Tail items after the main nav: admin (admins), households (super-admin only, demo), then
 *  profile. Sourced here so BOTH the desktop sidebar and the mobile "More" page get them.
 *  isSuper is always false off-demo, so the households entry only appears on the demo. */
export function navExtras(isAdmin: boolean, isSuper = false): NavItem[] {
  return [
    ...(isAdmin ? [{ to: '/admin', icon: Settings, key: 'nav.admin' }] : []),
    ...(isSuper ? [{ to: '/admin/households', icon: Building2, key: 'nav.households' }] : []),
    { to: '/profile', icon: UserCircle, key: 'nav.profile' },
  ];
}
