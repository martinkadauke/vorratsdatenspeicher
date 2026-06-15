// Beautiful, email-client-safe HTML financial report. No JS, no external images:
// charts are rendered as inline CSS bars (deterministic px widths) inside layout
// tables, everything inline-styled — so it looks crisp in Gmail, Apple Mail,
// Outlook, and dark mode alike.

interface Bar { label: string; value: number }
export interface ReportData {
  periodLabel: string;
  userName?: string;
  kpis: { spend: number; income: number; net: number };
  categories: Bar[];
  months: Bar[];
  appUrl: string;
}

const C = {
  bg: '#f4f4f5', card: '#ffffff', ink: '#18181b', sub: '#71717a', faint: '#a1a1aa',
  line: '#ececef', soft: '#fafafa', brand: '#10b981', brandDark: '#059669', rose: '#e11d48',
};

const eur = (n: number) => new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(n);
const esc = (s: string) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

/** One horizontal CSS bar row (label · bar · value). */
function barRow(b: Bar, max: number, color: string): string {
  const px = Math.max(4, Math.round((max > 0 ? b.value / max : 0) * 230));
  return `
    <tr>
      <td style="padding:7px 10px 7px 0;font-size:13px;color:${C.sub};white-space:nowrap;max-width:150px;overflow:hidden;text-overflow:ellipsis;">${esc(b.label)}</td>
      <td style="padding:7px 0;width:100%;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
          <td><div style="width:${px}px;height:11px;background:${color};border-radius:6px;"></div></td>
          <td style="padding-left:10px;font-size:13px;font-weight:600;color:${C.ink};white-space:nowrap;">${eur(b.value)}</td>
        </tr></table>
      </td>
    </tr>`;
}

function kpiCell(label: string, value: number, color: string): string {
  return `
    <td width="33.33%" style="padding:6px;" valign="top">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.soft};border:1px solid ${C.line};border-radius:12px;">
        <tr><td style="padding:14px 12px;text-align:center;">
          <div style="font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:${C.faint};">${esc(label)}</div>
          <div style="margin-top:6px;font-size:20px;font-weight:800;color:${color};white-space:nowrap;">${eur(value)}</div>
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

export function buildReport(d: ReportData): { subject: string; text: string; html: string } {
  const netColor = d.kpis.net < 0 ? C.rose : C.brandDark;
  const catMax = Math.max(0, ...d.categories.map(c => c.value));
  const monMax = Math.max(0, ...d.months.map(m => m.value));
  const periodLabel = d.periodLabel || 'Gesamter Zeitraum';
  const hello = d.userName ? `Hallo ${esc(d.userName)}, ` : '';

  const catRows = d.categories.length
    ? d.categories.map(c => barRow(c, catMax, C.brand)).join('')
    : `<tr><td style="padding:8px 0;font-size:13px;color:${C.faint};">Keine Daten</td></tr>`;
  const monRows = d.months.length
    ? d.months.map(m => barRow(m, monMax, '#6366f1')).join('')
    : `<tr><td style="padding:8px 0;font-size:13px;color:${C.faint};">Keine Daten</td></tr>`;

  const subject = `📊 Dein VDS Finanzreport · ${periodLabel}`;
  const preheader = `${hello}hier ist dein Finanzreport für ${periodLabel}.`;

  const html = `<!DOCTYPE html>
<html lang="de"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<title>VDS Finanzreport</title>
</head>
<body style="margin:0;padding:0;background:${C.bg};-webkit-font-smoothing:antialiased;">
<span style="display:none!important;visibility:hidden;opacity:0;height:0;width:0;overflow:hidden;mso-hide:all;">${esc(preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.bg};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <tr><td align="center" style="padding:24px 12px;">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:100%;background:${C.card};border-radius:16px;overflow:hidden;border:1px solid ${C.line};">

      <!-- header -->
      <tr><td style="background:${C.brandDark};background:linear-gradient(135deg,${C.brandDark} 0%,${C.brand} 100%);padding:30px 28px;">
        <div style="font-size:13px;font-weight:600;color:rgba(255,255,255,.8);letter-spacing:.02em;">🗄️ Vorratsdatenspeicher</div>
        <div style="margin-top:6px;font-size:24px;font-weight:800;color:#ffffff;">Finanzreport</div>
        <div style="margin-top:2px;font-size:14px;color:rgba(255,255,255,.85);">${esc(periodLabel)}</div>
      </td></tr>

      <!-- KPIs -->
      <tr><td style="padding:22px 22px 0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
          ${kpiCell('Ausgaben', d.kpis.spend, C.ink)}
          ${kpiCell('Einnahmen', d.kpis.income, C.brandDark)}
          ${kpiCell('Saldo', d.kpis.net, netColor)}
        </tr></table>
      </td></tr>

      ${section('Ausgaben pro Monat', monRows)}
      ${section('Top-Kategorien', catRows)}

      <!-- CTA -->
      <tr><td style="padding:26px 28px 6px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
          <td style="background:${C.brand};border-radius:10px;">
            <a href="${esc(d.appUrl)}/analytics" style="display:inline-block;padding:12px 22px;font-size:14px;font-weight:700;color:#ffffff;text-decoration:none;">Im Dashboard öffnen →</a>
          </td>
        </tr></table>
      </td></tr>

      <!-- footer -->
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
    `VDS Finanzreport — ${periodLabel}`,
    '',
    `Ausgaben:  ${eur(d.kpis.spend)}`,
    `Einnahmen: ${eur(d.kpis.income)}`,
    `Saldo:     ${eur(d.kpis.net)}`,
    '',
    'Ausgaben pro Monat:',
    ...d.months.map(m => `  ${m.label}: ${eur(m.value)}`),
    '',
    'Top-Kategorien:',
    ...d.categories.map(c => `  ${c.label}: ${eur(c.value)}`),
    '',
    `Dashboard: ${d.appUrl}/analytics`,
  ].join('\n');

  return { subject, text, html };
}
