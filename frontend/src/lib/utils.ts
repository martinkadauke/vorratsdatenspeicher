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
