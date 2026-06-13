// VDS-styled transactional emails. Inline styles + table layout only, so they
// render consistently across Gmail / Outlook / Apple Mail. Palette mirrors the
// app: zinc surfaces, emerald accent, 🗄️ wordmark.

const C = {
  bg: '#f4f4f5',          // zinc-100
  card: '#ffffff',
  border: '#e4e4e7',      // zinc-200
  heading: '#18181b',     // zinc-900
  body: '#3f3f46',        // zinc-700
  muted: '#71717a',       // zinc-500
  faint: '#a1a1aa',       // zinc-400
  brand: '#059669',       // emerald-600
  brandDark: '#047857',   // emerald-700
  accentBg: '#ecfdf5',    // emerald-50
  accentBorder: '#a7f3d0',// emerald-200
};

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Wraps inner content in the branded card + outer background. */
function layout(opts: { preheader: string; heading: string; inner: string }): string {
  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light only">
<title>${esc(opts.heading)}</title>
</head>
<body style="margin:0;padding:0;background:${C.bg};">
<span style="display:none!important;visibility:hidden;opacity:0;height:0;width:0;overflow:hidden;mso-hide:all;">${esc(opts.preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg};">
  <tr><td align="center" style="padding:32px 16px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;">
      <!-- brand -->
      <tr><td style="padding:0 4px 16px;">
        <table role="presentation" cellpadding="0" cellspacing="0"><tr>
          <td style="font-size:24px;line-height:1;padding-right:8px;">🗄️</td>
          <td style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;font-weight:700;color:${C.heading};letter-spacing:-0.01em;">Vorratsdatenspeicher</td>
        </tr></table>
      </td></tr>
      <!-- card -->
      <tr><td style="background:${C.card};border:1px solid ${C.border};border-radius:16px;padding:32px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
        ${opts.inner}
      </td></tr>
      <!-- footer -->
      <tr><td style="padding:16px 8px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:12px;line-height:1.5;color:${C.faint};">
        Vorratsdatenspeicher · der gemeinsame Vorrats- &amp; Ausgaben-Tracker für euren Haushalt.
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

type BtnVariant = 'primary' | 'secondary' | 'neutral';

/** A bulletproof CTA button. primary = filled emerald, secondary = emerald outline,
 *  neutral = grey outline. */
function button(label: string, href: string, variant: BtnVariant = 'primary'): string {
  const style = {
    primary: `background:${C.brand};color:#ffffff;border:1px solid ${C.brandDark};`,
    secondary: `background:#ffffff;color:${C.brandDark};border:1px solid ${C.accentBorder};`,
    neutral: `background:#ffffff;color:${C.muted};border:1px solid ${C.border};`,
  }[variant];
  const bg = variant === 'primary' ? C.brand : '#ffffff';
  return `<table role="presentation" cellpadding="0" cellspacing="0"><tr>
    <td align="center" bgcolor="${bg}" style="border-radius:12px;">
      <a href="${esc(href)}" target="_blank"
         style="display:inline-block;padding:13px 26px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;font-weight:600;text-decoration:none;border-radius:12px;${style}">
        ${esc(label)}
      </a>
    </td>
  </tr></table>`;
}

/** Standard "link is X hours/days valid + raw fallback link" block. */
function validityBlock(link: string, validity: string): string {
  return `
    <p style="margin:0 0 4px;font-size:13px;line-height:1.5;color:${C.muted};">
      Der Link ist <strong>${esc(validity)}</strong> gültig. Falls der Button nicht funktioniert, öffne diesen Link:
    </p>
    <p style="margin:0 0 24px;font-size:12px;line-height:1.5;word-break:break-all;">
      <a href="${esc(link)}" target="_blank" style="color:${C.brand};text-decoration:underline;">${esc(link)}</a>
    </p>`;
}

const footerNote = (text: string) => `
    <hr style="border:none;border-top:1px solid ${C.border};margin:0 0 16px;">
    <p style="margin:0;font-size:12px;line-height:1.5;color:${C.faint};">${esc(text)}</p>`;

/** Invitation email: someone was invited to set their password and join. */
export function inviteEmail(opts: { username: string; link: string }): { subject: string; text: string; html: string } {
  const subject = 'Deine Einladung zu Vorratsdatenspeicher 🗄️';
  const text =
    `Du wurdest zu Vorratsdatenspeicher eingeladen – dem gemeinsamen Vorrats- & Ausgaben-Tracker für euren Haushalt.\n\n` +
    `Dein Benutzername: ${opts.username}\n\n` +
    `Setze über diesen Link dein Passwort und leg los (7 Tage gültig):\n${opts.link}\n\n` +
    `Wenn du diese Einladung nicht erwartet hast, kannst du diese E-Mail ignorieren.`;

  const inner = `
    <h1 style="margin:0 0 12px;font-size:22px;line-height:1.3;font-weight:700;color:${C.heading};letter-spacing:-0.01em;">
      Du wurdest eingeladen 🎉
    </h1>
    <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:${C.body};">
      Willkommen bei <strong style="color:${C.heading};">Vorratsdatenspeicher</strong> – dem gemeinsamen
      Vorrats- &amp; Ausgaben-Tracker für euren Haushalt. Richte jetzt dein Passwort ein und du bist startklar.
    </p>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
           style="background:${C.accentBg};border:1px solid ${C.accentBorder};border-radius:12px;margin:0 0 24px;">
      <tr><td style="padding:12px 16px;font-size:13px;line-height:1.5;color:${C.brandDark};">
        Dein Benutzername<br>
        <strong style="font-size:16px;color:${C.heading};">${esc(opts.username)}</strong>
      </td></tr>
    </table>

    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 20px;"><tr><td>
      ${button('Passwort festlegen & loslegen', opts.link)}
    </td></tr></table>
    ${validityBlock(opts.link, '7 Tage')}
    ${footerNote('Wenn du diese Einladung nicht erwartet hast, kannst du diese E-Mail einfach ignorieren.')}`;

  return { subject, text, html: layout({ preheader: 'Richte dein Passwort ein und leg los.', heading: subject, inner }) };
}

/** Password-reset email (used by self-service "forgot" and the admin reset action). */
export function resetEmail(opts: { username: string; link: string; validity: string }): { subject: string; text: string; html: string } {
  const subject = 'Passwort zurücksetzen – Vorratsdatenspeicher';
  const text =
    `Hallo ${opts.username},\n\n` +
    `über diesen Link kannst du ein neues Passwort festlegen (${opts.validity} gültig):\n${opts.link}\n\n` +
    `Wenn du das nicht angefordert hast, kannst du diese E-Mail ignorieren.`;
  const inner = `
    <h1 style="margin:0 0 12px;font-size:22px;line-height:1.3;font-weight:700;color:${C.heading};letter-spacing:-0.01em;">
      Passwort zurücksetzen
    </h1>
    <p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:${C.body};">
      Hallo <strong style="color:${C.heading};">${esc(opts.username)}</strong>, hier kannst du ein neues Passwort
      für deinen Vorratsdatenspeicher-Zugang festlegen.
    </p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 20px;"><tr><td>
      ${button('Neues Passwort festlegen', opts.link)}
    </td></tr></table>
    ${validityBlock(opts.link, opts.validity)}
    ${footerNote('Wenn du das nicht angefordert hast, kannst du diese E-Mail ignorieren – dein Passwort bleibt unverändert.')}`;
  return { subject, text, html: layout({ preheader: 'Setze ein neues Passwort.', heading: subject, inner }) };
}

export interface DigestOffer {
  canonical_name: string; brand?: string | null; store?: string | null; price?: string | null;
  old_price?: string | null; valid_until?: string | null; source_url?: string | null;
  image_url?: string | null; unit?: string | null;
}

function offerCard(o: DigestOffer): string {
  const thumb = o.image_url
    ? `<td width="56" valign="top" style="padding-right:12px;"><img src="${esc(o.image_url)}" width="48" height="48" alt="" style="display:block;width:48px;height:48px;border-radius:8px;object-fit:contain;background:#fafafa;"></td>`
    : '';
  const price = o.price
    ? `<span style="font-size:15px;font-weight:700;color:${C.brand};">${esc(o.price)}${o.unit ? `/${esc(o.unit)}` : ''}</span>`
    : '';
  const old = o.old_price ? `<span style="font-size:12px;color:${C.faint};text-decoration:line-through;margin-left:6px;">${esc(o.old_price)}</span>` : '';
  const meta = [o.store ? esc(o.store) : '', o.valid_until ? esc(o.valid_until) : ''].filter(Boolean).join(' · ');
  const name = `${esc(o.canonical_name)}${o.brand ? ` <span style="color:${C.faint};font-weight:400;">${esc(o.brand)}</span>` : ''}`;
  const wrap = (html: string) => o.source_url
    ? `<a href="${esc(o.source_url)}" target="_blank" style="text-decoration:none;color:inherit;display:block;">${html}</a>`
    : html;
  return `<tr><td style="padding:0 0 10px;">
    ${wrap(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.card};border:1px solid ${C.border};border-radius:12px;">
      <tr><td style="padding:12px 14px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        ${thumb}
        <td valign="top">
          <div style="font-size:15px;font-weight:600;color:${C.heading};line-height:1.3;">${name}</div>
          <div style="margin-top:3px;font-size:12px;color:${C.muted};">${meta}</div>
        </td>
        <td valign="top" align="right" style="white-space:nowrap;padding-left:8px;">${price}${old}</td>
      </tr></table></td></tr>
    </table>`)}
  </td></tr>`;
}

/** Offer digest: the products a user subscribed to that are currently on offer. */
export function offerDigestEmail(opts: { offers: DigestOffer[]; appUrl: string }): { subject: string; text: string; html: string } {
  const n = opts.offers.length;
  const subject = `Neue Angebote für dich 🛒 (${n})`;
  const offersUrl = `${opts.appUrl.replace(/\/$/, '')}/offers`;
  const text =
    `Neue Angebote für deine abonnierten Artikel:\n\n` +
    opts.offers.map(o =>
      `• ${o.canonical_name}: ${o.store ?? '?'}${o.price ? ` – ${o.price}` : ''}` +
      `${o.old_price ? ` (statt ${o.old_price})` : ''}${o.valid_until ? ` (${o.valid_until})` : ''}` +
      `${o.source_url ? `\n    ${o.source_url}` : ''}`,
    ).join('\n\n') +
    `\n\nAlle Angebote: ${offersUrl}\n\n(laut Web-/Prospekt-Suche – bitte vor dem Kauf prüfen.)`;
  const inner = `
    <h1 style="margin:0 0 12px;font-size:22px;line-height:1.3;font-weight:700;color:${C.heading};letter-spacing:-0.01em;">
      Neue Angebote für dich 🛒
    </h1>
    <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:${C.body};">
      Für deine abonnierten Artikel haben wir aktuelle Angebote in der Nähe gefunden:
    </p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${opts.offers.map(offerCard).join('')}</table>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 20px;"><tr><td>
      ${button('Alle Angebote ansehen', offersUrl)}
    </td></tr></table>
    ${footerNote('Angaben laut Web-/Prospekt-Suche – bitte vor dem Kauf prüfen.')}`;
  return { subject, text, html: layout({ preheader: `${n} neue${n === 1 ? 's' : ''} Angebot${n === 1 ? '' : 'e'} für deine Artikel.`, heading: subject, inner }) };
}

export interface ReviewProposal {
  task: string; current_model: string;
  api?: { model: string; provider: string; reason: string } | null;
  open?: { model: string; reason: string } | null;
}

/** AI model-review digest with 3 one-click decision buttons (super-admin). */
export function modelReviewEmail(opts: {
  proposals: ReviewProposal[];
  links: { apply_api: string; apply_open: string; reject: string };
}): { subject: string; text: string; html: string } {
  const subject = 'KI-Modell-Review – Vorschläge';
  const text =
    `Der KI-Modell-Review hat pro Aufgabe je ein API- und ein Open-Weight-Modell vorgeschlagen:\n\n` +
    opts.proposals.map(p =>
      `• ${p.task}  (aktuell: ${p.current_model})\n` +
      `    API:  ${p.api ? `${p.api.model} [${p.api.provider}] – ${p.api.reason}` : '—'}\n` +
      `    Open: ${p.open ? `${p.open.model} – ${p.open.reason}` : '—'}`,
    ).join('\n\n') +
    `\n\nAlle API-Modelle übernehmen: ${opts.links.apply_api}\n` +
    `Alle Open-Weight-Modelle übernehmen: ${opts.links.apply_open}\n` +
    `Ablehnen: ${opts.links.reject}`;
  const rows = opts.proposals.map(p => `
    <tr><td style="padding:10px 0;border-top:1px solid ${C.border};">
      <div style="font-size:14px;font-weight:600;color:${C.heading};">${esc(p.task)}</div>
      <div style="font-size:12px;color:${C.faint};margin-bottom:6px;">aktuell: ${esc(p.current_model)}</div>
      <div style="font-size:13px;color:${C.body};line-height:1.5;">
        <span style="display:inline-block;min-width:42px;color:${C.muted};">API</span> ${p.api ? `<strong>${esc(p.api.model)}</strong> <span style="color:${C.faint};">[${esc(p.api.provider)}]</span>` : '—'}<br>
        <span style="display:inline-block;min-width:42px;color:${C.muted};">Open</span> ${p.open ? `<strong>${esc(p.open.model)}</strong>` : '—'}
      </div>
    </td></tr>`).join('');
  const inner = `
    <h1 style="margin:0 0 12px;font-size:22px;line-height:1.3;font-weight:700;color:${C.heading};letter-spacing:-0.01em;">
      KI-Modell-Review
    </h1>
    <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:${C.body};">
      Pro KI-Aufgabe wurde je ein API- und ein Open-Weight-Modell vorgeschlagen:
    </p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;">${rows}</table>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 10px;"><tr><td>${button('Alle API-Modelle übernehmen', opts.links.apply_api, 'primary')}</td></tr></table>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 10px;"><tr><td>${button('Alle Open-Weight-Modelle übernehmen', opts.links.apply_open, 'secondary')}</td></tr></table>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 20px;"><tr><td>${button('Ablehnen (nichts ändern)', opts.links.reject, 'neutral')}</td></tr></table>
    ${footerNote('Du kannst die Modelle jederzeit manuell in Admin → KI-Aufgaben ändern.')}`;
  return { subject, text, html: layout({ preheader: 'Vorschläge je API- und Open-Weight-Modell.', heading: subject, inner }) };
}

/** Generic one-line notice (e.g. the SMTP test mail). */
export function noticeEmail(opts: { subject: string; heading: string; body: string }): { subject: string; text: string; html: string } {
  const inner = `
    <h1 style="margin:0 0 12px;font-size:22px;line-height:1.3;font-weight:700;color:${C.heading};letter-spacing:-0.01em;">
      ${esc(opts.heading)}
    </h1>
    <p style="margin:0;font-size:15px;line-height:1.6;color:${C.body};">${esc(opts.body)}</p>`;
  return { subject: opts.subject, text: opts.body, html: layout({ preheader: opts.body, heading: opts.subject, inner }) };
}
