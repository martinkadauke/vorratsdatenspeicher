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

/** A bulletproof emerald CTA button. */
function button(label: string, href: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0"><tr>
    <td align="center" bgcolor="${C.brand}" style="border-radius:12px;">
      <a href="${esc(href)}" target="_blank"
         style="display:inline-block;padding:14px 28px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:12px;border:1px solid ${C.brandDark};">
        ${esc(label)}
      </a>
    </td>
  </tr></table>`;
}

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

    <p style="margin:0 0 4px;font-size:13px;line-height:1.5;color:${C.muted};">
      Der Link ist <strong>7 Tage</strong> gültig. Falls der Button nicht funktioniert, öffne diesen Link:
    </p>
    <p style="margin:0 0 24px;font-size:12px;line-height:1.5;word-break:break-all;">
      <a href="${esc(opts.link)}" target="_blank" style="color:${C.brand};text-decoration:underline;">${esc(opts.link)}</a>
    </p>

    <hr style="border:none;border-top:1px solid ${C.border};margin:0 0 16px;">
    <p style="margin:0;font-size:12px;line-height:1.5;color:${C.faint};">
      Wenn du diese Einladung nicht erwartet hast, kannst du diese E-Mail einfach ignorieren.
    </p>`;

  return { subject, text, html: layout({ preheader: 'Richte dein Passwort ein und leg los.', heading: subject, inner }) };
}
