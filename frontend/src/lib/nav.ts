import {
  LayoutDashboard, ReceiptText, ShoppingCart, BadgePercent, Boxes, Store,
  ListChecks, ChartPie, Settings, UserCircle, type LucideIcon,
} from 'lucide-react';

export interface NavItem { to: string; icon: LucideIcon; key: string }

// Single source of truth for nav order. The first MOBILE_PRIMARY items also form
// the mobile bottom bar; the rest live under "Mehr" on mobile and inline on desktop.
export const NAV: NavItem[] = [
  { to: '/receipts', icon: ReceiptText, key: 'nav.receipts' },       // belege (Startseite)
  { to: '/shopping', icon: ShoppingCart, key: 'nav.shopping' },      // liste
  { to: '/offers', icon: BadgePercent, key: 'nav.offers' },          // angebote
  { to: '/warenstamm', icon: Boxes, key: 'nav.warenstamm' },         // warenstamm (artikel/positionen/vorrat)
  { to: '/stores', icon: Store, key: 'nav.stores' },                 // läden
  { to: '/queue', icon: ListChecks, key: 'nav.queue' },              // prüfung
  { to: '/stats', icon: ChartPie, key: 'nav.stats' },                // statistik
  { to: '/analytics', icon: LayoutDashboard, key: 'nav.analytics' }, // analytics (ganz hinten)
];

export const MOBILE_PRIMARY = 4;

/** Tail items after the main nav: admin (only for admins), then profile. */
export function navExtras(isAdmin: boolean): NavItem[] {
  return [
    ...(isAdmin ? [{ to: '/admin', icon: Settings, key: 'nav.admin' }] : []),
    { to: '/profile', icon: UserCircle, key: 'nav.profile' },
  ];
}
