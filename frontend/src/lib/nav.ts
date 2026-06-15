import {
  LayoutDashboard, ReceiptText, ShoppingCart, BadgePercent, Tags, Store,
  ListChecks, ChartPie, Settings, UserCircle, type LucideIcon,
} from 'lucide-react';

export interface NavItem { to: string; icon: LucideIcon; key: string }

// Single source of truth for nav order. The first MOBILE_PRIMARY items also form
// the mobile bottom bar; the rest live under "Mehr" on mobile and inline on desktop.
export const NAV: NavItem[] = [
  { to: '/analytics', icon: LayoutDashboard, key: 'nav.analytics' }, // analytics
  { to: '/receipts', icon: ReceiptText, key: 'nav.receipts' },       // belege
  { to: '/shopping', icon: ShoppingCart, key: 'nav.shopping' },      // liste
  { to: '/offers', icon: BadgePercent, key: 'nav.offers' },          // angebote
  { to: '/names', icon: Tags, key: 'nav.names' },                    // artikel
  { to: '/stores', icon: Store, key: 'nav.stores' },                 // läden
  { to: '/queue', icon: ListChecks, key: 'nav.queue' },              // prüfung
  { to: '/stats', icon: ChartPie, key: 'nav.stats' },                // statistik
];

export const MOBILE_PRIMARY = 4;

/** Tail items after the main nav: admin (only for admins), then profile. */
export function navExtras(isAdmin: boolean): NavItem[] {
  return [
    ...(isAdmin ? [{ to: '/admin', icon: Settings, key: 'nav.admin' }] : []),
    { to: '/profile', icon: UserCircle, key: 'nav.profile' },
  ];
}
