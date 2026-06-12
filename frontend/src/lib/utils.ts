import clsx, { type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { getToken } from '../api/client';

/** Compose class names, resolving conflicting Tailwind utilities so a later
 *  override (e.g. a passed `bg-emerald-100`) beats an earlier base
 *  (`bg-zinc-100`) instead of both coexisting. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(...inputs));
}

/** Trigger a browser download of an authenticated endpoint (e.g. a CSV). */
export async function downloadFile(path: string, filename: string): Promise<void> {
  const token = getToken();
  const res = await fetch(path, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Human-readable byte size (e.g. 12.3 MB). */
export function fmtBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i ? 1 : 0)} ${units[i]}`;
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

/** Render a (subset of) cron expressions as human-readable schedule text.
 *  Supports daily "M H * * *", "M H * * D" (weekday), "0 *​/N * * *" intervals.
 *  Falls back to the raw expression for everything else. */
export function cronToHuman(cron: string, lang = 'de'): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron;
  const [minute, hour, dom, month, dow] = parts;

  const de = {
    daily: (h: string, m: string) => `Täglich um ${h.padStart(2, '0')}:${m.padStart(2, '0')} Uhr`,
    weekly: (d: string, h: string, m: string) => `Jeden ${d} um ${h.padStart(2, '0')}:${m.padStart(2, '0')} Uhr`,
    everyHours: (n: string) => `Alle ${n} Stunden`,
    everyMinutes: (n: string) => `Alle ${n} Minuten`,
    days: ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'],
  };
  const en = {
    daily: (h: string, m: string) => `Daily at ${h.padStart(2, '0')}:${m.padStart(2, '0')}`,
    weekly: (d: string, h: string, m: string) => `Every ${d} at ${h.padStart(2, '0')}:${m.padStart(2, '0')}`,
    everyHours: (n: string) => `Every ${n} hours`,
    everyMinutes: (n: string) => `Every ${n} minutes`,
    days: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
  };
  const i18n = lang === 'en' ? en : de;

  const isInt = (s: string) => /^\d+$/.test(s);
  const everyN = (s: string) => s.startsWith('*/') && isInt(s.slice(2)) ? s.slice(2) : null;

  // Daily at HH:MM
  if (isInt(minute) && isInt(hour) && dom === '*' && month === '*' && dow === '*') {
    return i18n.daily(hour, minute);
  }
  // Weekly: minute hour * * <day>
  if (isInt(minute) && isInt(hour) && dom === '*' && month === '*' && isInt(dow)) {
    const idx = parseInt(dow, 10) % 7;
    return i18n.weekly(i18n.days[idx], hour, minute);
  }
  // Every N hours
  const hr = everyN(hour);
  if (minute === '0' && hr && dom === '*' && month === '*' && dow === '*') {
    return i18n.everyHours(hr);
  }
  // Every N minutes
  const mn = everyN(minute);
  if (mn && hour === '*' && dom === '*' && month === '*' && dow === '*') {
    return i18n.everyMinutes(mn);
  }
  return cron;
}
