// Beautiful, email-client-safe HTML report rendered from a dashboard's tiles —
// the very dashboard the user generated (via natural language or the default
// view). No JS and no HOTLINKED images: KPI cards + CSS bar charts (deterministic
// px widths) in layout tables, all inline-styled. The brand mark travels with the
// message as an inline CID attachment (see email/logo.ts), so it renders on a LAN
// box too; the mailer attaches it whenever this HTML cites the CID.

import { LOGO_CID, hasEmailLogo } from '../email/logo.js';

interface ReportTile { type: string; title: string; unit: 'eur' | 'count'; rows: { label: string; value: number }[] }
export interface ReportInput {
  title: string;
  summary?: string;
  periodLabel: string;
  userName?: string;
  appUrl: string;
  tiles: ReportTile[];
}

const C = {
  bg: '#f4f4f5', card: '#ffffff', ink: '#18181b', sub: '#71717a', faint: '#a1a1aa',
  line: '#ececef', soft: '#fafafa', brand: '#10b981', brandDark: '#059669', rose: '#e11d48', indigo: '#6366f1',
};

const eur = (n: number) => new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(n);
const cnt = (n: number) => new Intl.NumberFormat('de-DE').format(Math.round(n));
const fmtVal = (n: number, unit: 'eur' | 'count') => (unit === 'eur' ? eur(n) : cnt(n));
const esc = (s: string) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
const sum = (rows: { value: number }[]) => rows.reduce((s, r) => s + (r.value || 0), 0);

function barRow(label: string, value: number, max: number, unit: 'eur' | 'count', color: string): string {
  const px = Math.max(4, Math.round((max > 0 ? Math.abs(value) / max : 0) * 230));
  return `
    <tr>
      <td style="padding:7px 10px 7px 0;font-size:13px;color:${C.sub};white-space:nowrap;max-width:150px;overflow:hidden;text-overflow:ellipsis;">${esc(label)}</td>
      <td style="padding:7px 0;width:100%;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
          <td><div style="width:${px}px;height:11px;background:${color};border-radius:6px;"></div></td>
          <td style="padding-left:10px;font-size:13px;font-weight:600;color:${C.ink};white-space:nowrap;">${fmtVal(value, unit)}</td>
        </tr></table>
      </td>
    </tr>`;
}

function kpiCell(label: string, value: number, unit: 'eur' | 'count'): string {
  const color = value < 0 ? C.rose : C.ink;
  return `
    <td style="padding:6px;" valign="top">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.soft};border:1px solid ${C.line};border-radius:12px;">
        <tr><td style="padding:14px 10px;text-align:center;">
          <div style="font-size:11px;font-weight:600;letter-spacing:.03em;text-transform:uppercase;color:${C.faint};">${esc(label)}</div>
          <div style="margin-top:6px;font-size:19px;font-weight:800;color:${color};white-space:nowrap;">${fmtVal(value, unit)}</div>
        </td></tr>
      </table>
    </td>`;
}

function section(title: string, rowsHtml: string): string {
  return `
    <tr><td style="padding:22px 28px 0;">
      <div style="font-size:15px;font-weight:700;color:${C.ink};">${esc(title)}</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:8px;">${rowsHtml}</table>
    </td></tr>`;
}

export function buildReport(d: ReportInput): { subject: string; text: string; html: string } {
  const kpis = d.tiles.filter(t => t.type === 'kpi').slice(0, 4);
  const charts = d.tiles.filter(t => t.type !== 'kpi');
  const title = d.title || 'Finanzreport';
  const hello = d.userName ? `Hallo ${esc(d.userName)}, ` : '';
  const colors = [C.brand, C.indigo, C.brandDark, '#8b5cf6'];

  const kpiRow = kpis.length
    ? `<tr><td style="padding:22px 22px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>${kpis.map(k => kpiCell(k.title, sum(k.rows), k.unit)).join('')}</tr></table></td></tr>`
    : '';

  const chartSections = charts.map((t, i) => {
    const max = Math.max(0, ...t.rows.map(r => Math.abs(r.value)));
    const rows = t.rows.length
      ? t.rows.slice(0, 12).map(r => barRow(r.label, r.value, max, t.unit, colors[i % colors.length])).join('')
      : `<tr><td style="padding:8px 0;font-size:13px;color:${C.faint};">Keine Daten</td></tr>`;
    return section(t.title, rows);
  }).join('');

  const subject = `📊 ${title}${d.periodLabel ? ` · ${d.periodLabel}` : ''}`;
  const preheader = `${hello}${d.summary || `hier ist dein Report${d.periodLabel ? ` für ${d.periodLabel}` : ''}.`}`;

  const html = `<!DOCTYPE html>
<html lang="de"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting"><title>${esc(title)}</title>
</head>
<body style="margin:0;padding:0;background:${C.bg};-webkit-font-smoothing:antialiased;">
<span style="display:none!important;visibility:hidden;opacity:0;height:0;width:0;overflow:hidden;mso-hide:all;">${esc(preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.bg};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <tr><td align="center" style="padding:24px 12px;">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:100%;background:${C.card};border-radius:16px;overflow:hidden;border:1px solid ${C.line};">

      <tr><td style="background:${C.brandDark};background:linear-gradient(135deg,${C.brandDark} 0%,${C.brand} 100%);padding:30px 28px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
          ${hasEmailLogo() ? `<td style="padding-right:8px;"><img src="cid:${LOGO_CID}" width="20" height="20" alt="" style="display:block;width:20px;height:20px;border:0;border-radius:5px;"></td>` : ''}
          <td style="font-size:13px;font-weight:600;color:rgba(255,255,255,.8);">Vorratsdatenspeicher</td>
        </tr></table>
        <div style="margin-top:6px;font-size:23px;font-weight:800;color:#ffffff;">${esc(title)}</div>
        ${d.periodLabel ? `<div style="margin-top:2px;font-size:14px;color:rgba(255,255,255,.85);">${esc(d.periodLabel)}</div>` : ''}
      </td></tr>

      ${d.summary ? `<tr><td style="padding:18px 28px 0;font-size:14px;line-height:1.6;color:${C.sub};">${esc(d.summary)}</td></tr>` : ''}
      ${kpiRow}
      ${chartSections}

      <tr><td style="padding:26px 28px 6px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
          <td style="background:${C.brand};border-radius:10px;">
            <a href="${esc(d.appUrl)}/analytics" style="display:inline-block;padding:12px 22px;font-size:14px;font-weight:700;color:#ffffff;text-decoration:none;">Im Dashboard öffnen →</a>
          </td>
        </tr></table>
      </td></tr>

      <tr><td style="padding:20px 28px 28px;">
        <div style="border-top:1px solid ${C.line};padding-top:16px;font-size:12px;line-height:1.6;color:${C.faint};">
          Automatisch von deinem Vorratsdatenspeicher erstellt. Alle Beträge stammen direkt aus deinen erfassten Daten.
        </div>
      </td></tr>

    </table>
  </td></tr>
</table>
</body></html>`;

  const text = [
    `${title}${d.periodLabel ? ` — ${d.periodLabel}` : ''}`,
    d.summary ? `\n${d.summary}` : '',
    ...kpis.map(k => `\n${k.title}: ${fmtVal(sum(k.rows), k.unit)}`),
    ...charts.map(t => `\n${t.title}:\n${t.rows.slice(0, 12).map(r => `  ${r.label}: ${fmtVal(r.value, t.unit)}`).join('\n')}`),
    `\nDashboard: ${d.appUrl}/analytics`,
  ].join('\n');

  return { subject, text, html };
}
