import clsx, { type ClassValue } from 'clsx';

export function cn(...inputs: ClassValue[]): string {
  return clsx(...inputs);
}

const eurFmt = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
export function eur(n: number | string | null | undefined): string {
  if (n === null || n === undefined) return '–';
  return eurFmt.format(Number(n));
}

export function fmtDate(d: string | null | undefined, lang = 'de'): string {
  if (!d) return '–';
  return new Date(d).toLocaleDateString(lang === 'en' ? 'en-GB' : 'de-DE', {
    day: '2-digit', month: '2-digit', year: 'numeric',
  });
}

export function monthLabel(year: number, month: number, lang = 'de'): string {
  return new Date(year, month - 1, 1).toLocaleDateString(lang === 'en' ? 'en-GB' : 'de-DE', {
    month: 'long', year: 'numeric',
  });
}
