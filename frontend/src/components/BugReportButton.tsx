import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bug, X, Pencil, Square, Undo2, Trash2, Loader2, ImageOff, ImagePlus, MailWarning } from 'lucide-react';
import { api, ApiError } from '../api/client';
import { useAuth } from '../context/auth';
import { Button, Input, Label, Switch, canFileReport, useEscapeLayer, useScrollLock } from './ui';
import { SmtpHelp } from './SmtpHelp';

/** Every report goes here, from every build — demo, dev, prod and self-hosted alike. Spelled
 *  out in the consent line and in the "no mail" notice on purpose: the person about to send a
 *  screenshot of their own receipts has to see WHO receives it before it leaves their box. */
const DEV_MAIL = 'webmaster@vorratsdatenspeicher.com';

/** 'smtp_unconfigured' = nothing entered at all, 'smtp_failed' = entered but the server refuses
 *  the connection or the login. Different sentence, same fix, so the reason only changes the
 *  wording of the notice. */
type MailState = { ok: boolean; reason: string | null };

/** Exactly what goes on the wire — kept as a value so a retry resends what the user consented to,
 *  byte for byte, instead of rebuilding it from a UI that has since moved on. */
type ReportPayload = { message: string; page: string; screenshot_base64?: string; consent?: boolean };

/** Can this instance actually put mail on the wire? A self-hoster may have no SMTP at all, or
 *  half-filled settings that look fine and bounce every send — in both cases the report is
 *  stored locally and reaches nobody, so we ask instead of promising.
 *  `null` means "don't know" (endpoint unreachable, e.g. an older backend): stay quiet rather
 *  than nag with a warning we cannot back up, and behave exactly as before. */
async function probeMail(): Promise<MailState | null> {
  try {
    const res = await api<{ ok?: boolean; reason?: string | null }>('/api/bug-reports/mail-status');
    return typeof res?.ok === 'boolean' ? { ok: res.ok, reason: res.reason ?? null } : null;
  } catch { return null; }
}

type Shape =
  | { type: 'pen'; color: string; points: [number, number][] }
  | { type: 'box'; color: string; x: number; y: number; w: number; h: number };

const COLORS = ['#ef4444', '#f59e0b', '#22c55e', '#3b82f6', '#ffffff', '#111111'];

interface AnnotatorHandle { getMerged: () => string | null; undo: () => void; clear: () => void; }

/** The captured screenshot with a transparent canvas over it that the user can
 *  scribble on — freehand (pen) or rectangles (box). Shapes are stored in the
 *  image's own pixel space, so getMerged() composites screenshot + drawings at
 *  full resolution for sending. */
const ShotAnnotator = forwardRef<AnnotatorHandle, { shot: string; color: string; tool: 'pen' | 'box' }>(
  function ShotAnnotator({ shot, color, tool }, ref) {
    const imgRef = useRef<HTMLImageElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const shapes = useRef<Shape[]>([]);
    const drawing = useRef<Shape | null>(null);
    const [, force] = useState(0);

    const redraw = useCallback(() => {
      const cv = canvasRef.current, img = imgRef.current;
      if (!cv || !img || !img.naturalWidth) return;
      if (cv.width !== img.naturalWidth) { cv.width = img.naturalWidth; cv.height = img.naturalHeight; }
      const ctx = cv.getContext('2d');
      if (!ctx) return;
      ctx.clearRect(0, 0, cv.width, cv.height);
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      const lw = Math.max(2.5, cv.width / 300);
      const all = drawing.current ? [...shapes.current, drawing.current] : shapes.current;
      for (const s of all) {
        ctx.strokeStyle = s.color; ctx.lineWidth = lw;
        if (s.type === 'pen') {
          ctx.beginPath();
          s.points.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
          ctx.stroke();
        } else {
          ctx.strokeRect(s.x, s.y, s.w, s.h);
        }
      }
    }, []);

    useEffect(() => { redraw(); });   // reflect undo / clear / in-progress strokes

    useImperativeHandle(ref, () => ({
      undo() { shapes.current.pop(); force(n => n + 1); },
      clear() { shapes.current = []; force(n => n + 1); },
      getMerged() {
        const img = imgRef.current, cv = canvasRef.current;
        if (!img || !cv || !img.naturalWidth) return null;
        const out = document.createElement('canvas');
        out.width = img.naturalWidth; out.height = img.naturalHeight;
        const ctx = out.getContext('2d');
        if (!ctx) return null;
        ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, out.width, out.height); // jpeg has no alpha
        ctx.drawImage(img, 0, 0);
        ctx.drawImage(cv, 0, 0);
        return out.toDataURL('image/jpeg', 0.85);
      },
    }), []);

    const pt = (e: React.PointerEvent): [number, number] => {
      const cv = canvasRef.current!, r = cv.getBoundingClientRect();
      return [(e.clientX - r.left) * (cv.width / r.width), (e.clientY - r.top) * (cv.height / r.height)];
    };
    const down = (e: React.PointerEvent) => {
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      const [x, y] = pt(e);
      drawing.current = tool === 'pen' ? { type: 'pen', color, points: [[x, y]] } : { type: 'box', color, x, y, w: 0, h: 0 };
      redraw();
    };
    const move = (e: React.PointerEvent) => {
      const d = drawing.current;
      if (!d) return;
      // Mouse only: if the button was released without us seeing pointerup, drop the
      // in-progress shape instead of letting it follow the cursor ("stuck stroke").
      if (e.pointerType === 'mouse' && e.buttons === 0) { drawing.current = null; force(n => n + 1); return; }
      const [x, y] = pt(e);
      if (d.type === 'pen') d.points.push([x, y]);
      else { d.w = x - d.x; d.h = y - d.y; }
      redraw();
    };
    const up = () => {
      const d = drawing.current;
      if (!d) return;
      drawing.current = null;
      const trivial = (d.type === 'box' && Math.abs(d.w) < 4 && Math.abs(d.h) < 4) || (d.type === 'pen' && d.points.length < 2);
      if (!trivial) shapes.current.push(d);
      force(n => n + 1);
    };
    // pointercancel (common on touch — palm, gesture, second finger): discard the stroke.
    const cancel = () => { drawing.current = null; force(n => n + 1); };

    return (
      <div className="relative select-none rounded-xl border border-zinc-200 dark:border-zinc-700">
        <img ref={imgRef} src={shot} alt="" className="block w-full" draggable={false} onLoad={redraw} />
        <canvas
          ref={canvasRef}
          className="absolute inset-0 h-full w-full touch-none"
          style={{ cursor: 'crosshair' }}
          onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={cancel}
        />
      </div>
    );
  },
);

/** The SMTP fields, held in local state and written only on "Speichern". The rest of the app
 *  saves app_config on blur, but here "Abbrechen" is a promise: the user opened this dialog out
 *  of a half-written bug report and must be able to back out without having changed the mail
 *  server of the whole instance on the way. "Test senden" honours the same promise — it hands the
 *  typed fields to the backend instead of storing them first. */
function SmtpForm({ config, onClose }: { config: Record<string, unknown>; onClose: () => void }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const qc = useQueryClient();
  const [f, setF] = useState({
    host: String(config['smtp.host'] ?? ''),
    port: String(config['smtp.port'] ?? '587'),
    user: String(config['smtp.user'] ?? ''),
    pass: String(config['smtp.pass'] ?? ''),
    from: String(config['smtp.from'] ?? ''),
    secure: !!config['smtp.secure'],
  });
  const [testTo, setTestTo] = useState(user?.email ?? '');
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);

  // One PUT per key — /api/config/:key is the only writer the backend offers. Untouched fields
  // are skipped so re-opening this dialog and pressing Speichern cannot rewrite a stored value
  // with a rounded/retyped version of itself.
  const saveAll = async () => {
    const next: Record<string, unknown> = {
      'smtp.host': f.host.trim(),
      'smtp.port': Number(f.port) || 587,
      'smtp.user': f.user.trim(),
      'smtp.pass': f.pass,
      'smtp.from': f.from.trim(),
      'smtp.secure': f.secure,
    };
    for (const [key, value] of Object.entries(next)) {
      if (String(config[key] ?? '') === String(value)) continue;
      await api(`/api/config/${key}`, { method: 'PUT', body: { value } });
    }
    await qc.invalidateQueries({ queryKey: ['config'] });
  };

  const save = useMutation({
    mutationFn: saveAll,
    onSuccess: onClose,
    onError: (e: Error) => setResult({ ok: false, msg: e.message }),
  });
  const test = useMutation({
    // The fields travel WITH the test instead of being written first. /api/smtp/test used to send
    // through the stored config only, so the client saved before testing — which turned one trial
    // run with a typo'd host into the instance's new mail server (invites, password resets and the
    // offer digest included) and made a following "Abbrechen" a lie. Now nothing is stored until
    // the operator presses Speichern.
    mutationFn: async () => {
      await api('/api/smtp/test', {
        method: 'POST',
        body: {
          to: testTo,
          settings: {
            host: f.host.trim(), port: Number(f.port) || 587, secure: f.secure,
            user: f.user.trim(), pass: f.pass,
            // Empty = untouched = keep whatever sender the instance already uses.
            from: f.from.trim() || undefined,
          },
        },
      });
    },
    onSuccess: () => setResult({ ok: true, msg: t('bugReport.smtp.testOk') }),
    onError: (e: Error) => setResult({ ok: false, msg: e.message }),
  });
  const busy = save.isPending || test.isPending;

  const field = (key: 'host' | 'port' | 'user' | 'pass' | 'from', label: string, opts: { type?: string; placeholder?: string; wide?: boolean } = {}) => (
    <div className={opts.wide ? 'sm:col-span-2' : undefined}>
      <Label>{label}</Label>
      <Input
        type={opts.type ?? 'text'} autoComplete="off" placeholder={opts.placeholder}
        value={f[key]} onChange={e => setF(s => ({ ...s, [key]: e.target.value }))}
      />
    </div>
  );

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        {field('host', t('bugReport.smtp.host'), { placeholder: 'smtp.gmail.com' })}
        {field('port', t('bugReport.smtp.port'), { type: 'number', placeholder: '587' })}
        {field('user', t('bugReport.smtp.user'), { placeholder: 'name@gmx.de' })}
        {field('pass', t('bugReport.smtp.pass'), { type: 'password' })}
        {field('from', t('bugReport.smtp.from'), { placeholder: 'VDS <name@gmx.de>', wide: true })}
        <div className="flex items-center justify-between sm:col-span-2">
          <span className="text-sm font-medium">{t('bugReport.smtp.secure')}</span>
          <Switch checked={f.secure} onChange={v => setF(s => ({ ...s, secure: v }))} />
        </div>
      </div>

      <div className="mt-3 flex items-end gap-2">
        <div className="flex-1">
          <Label>{t('bugReport.smtp.testTo')}</Label>
          <Input type="email" value={testTo} onChange={e => setTestTo(e.target.value)} placeholder="test@…" />
        </div>
        {/* Same host guard as Speichern: without a host there is nothing to connect to, and the
            test would only report the stored server's verdict under the typed fields' name. */}
        <Button variant="secondary" disabled={!testTo || !f.host.trim() || busy} onClick={() => { setResult(null); test.mutate(); }}>
          {t('bugReport.smtp.test')}
        </Button>
      </div>
      {result && (
        <p className={`mt-2 text-xs font-medium ${result.ok ? 'text-emerald-600' : 'text-red-500'}`}>{result.msg}</p>
      )}

      <div className="mt-3"><SmtpHelp /></div>

      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose} disabled={busy}>{t('common.cancel')}</Button>
        <Button onClick={() => { setResult(null); save.mutate(); }} disabled={!f.host.trim() || busy}>{t('common.save')}</Button>
      </div>
    </>
  );
}

/** SMTP setup opened ON TOP of the bug report (z-[120] over its z-[110]) — never instead of it.
 *  The report stays mounted underneath with its text, its screenshot and the annotations drawn
 *  on it, so both "Speichern" and "Abbrechen" drop the user back into exactly what they were
 *  writing. Losing a typed-out bug report to the dialog that was meant to fix sending it would
 *  be its own bug. */
function SmtpSetupDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const { data: config } = useQuery({ queryKey: ['config'], queryFn: () => api<Record<string, unknown>>('/api/config') });
  useEscapeLayer(true, onClose);   // mounted only while open, so the layer token is pushed last → Escape hits THIS dialog
  useScrollLock(true);

  return (
    <div data-html2canvas-ignore className="fixed inset-0 z-[120] flex items-end justify-center bg-black/50 p-4 sm:items-center" onClick={onClose}>
      <div className="max-h-[92vh] w-full max-w-md overflow-y-auto rounded-2xl bg-white p-5 shadow-xl dark:bg-zinc-900" onClick={e => e.stopPropagation()}>
        <div className="mb-1 flex items-center justify-between">
          <h2 className="text-base font-bold">{t('bugReport.smtp.title')}</h2>
          <button onClick={onClose} className="rounded-lg p-1 text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800"><X size={18} /></button>
        </div>
        <p className="mb-3 text-xs text-zinc-500 dark:text-zinc-400">{t('bugReport.smtp.intro')}</p>
        {config
          ? <SmtpForm config={config} onClose={onClose} />
          : <p className="py-6 text-center text-sm text-zinc-400">{t('common.loading')}</p>}
      </div>
    </div>
  );
}

/** Feedback / bug report. Two placements share one modal:
 *  - variant="header": a small icon button for the top bar, present in ALL builds.
 *  - variant="floating" (default): the demo's bottom-left floating pill.
 *  On open it screenshots the current view (html2canvas, loaded on demand); the
 *  user can draw / box on it, and the annotated image + page + household go along.
 *
 *  The report always travels to the developer (DEV_MAIL) — that is what makes the send worth
 *  doing at all — so off-demo it is gated on DISCLOSURE rather than hidden: an explicit tick
 *  that names the address, the screenshot and the reply-to identity, plus the option to drop the
 *  screenshot and send the words alone. The tick goes on the wire with the report, because the
 *  server is where the forward is decided. On the demo the operator is already the controller of
 *  that data, so the tick would be noise and is skipped. */
export function BugReportButton({ variant = 'floating' }: { variant?: 'floating' | 'header' } = {}) {
  const { t, i18n } = useTranslation();
  const de = i18n.language.startsWith('de');
  const { pathname } = useLocation();
  const { user, demo } = useAuth();
  const [open, setOpen] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [shot, setShot] = useState<string | null>(null);
  const [tool, setTool] = useState<'pen' | 'box'>('box');
  const [color, setColor] = useState(COLORS[0]);
  const [msg, setMsg] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [includeShot, setIncludeShot] = useState(true);
  const [consent, setConsent] = useState(false);
  /** null = not asked / unknown, ok:false = mail cannot leave this instance. */
  const [mail, setMail] = useState<MailState | null>(null);
  const [smtpOpen, setSmtpOpen] = useState(false);
  /** The report was stored but could not be mailed — a result to read, not a flash. */
  const [storedOnly, setStoredOnly] = useState(false);
  /** Neither stored nor mailed (a failed INSERT on top of dead mail). Its own ending: telling
   *  someone their report "liegt auf diesem Server" when it only exists in a log line is the same
   *  silent loss this whole change set out to remove, one level down. */
  const [lost, setLost] = useState(false);
  /** Why the forward did not happen, as the POST reported it. 'consent_missing' needs a different
   *  sentence from the two SMTP reasons and says nothing about the mail setup. */
  const [sendReason, setSendReason] = useState<string | null>(null);
  /** The POST was rejected outright (demo hourly limit, read-only account, 413, 502 mid-deploy).
   *  Swallowed until now, which left the user tapping a button that did nothing, forever. */
  const [error, setError] = useState<string | null>(null);
  const annot = useRef<AnnotatorHandle>(null);
  const sentTimer = useRef<ReturnType<typeof setTimeout>>();
  /** The body that was actually sent, kept for "Erneut senden". The failed endings unmount the
   *  annotator, so a retry has to resend THIS image — re-reading the canvas would hand back an
   *  empty one and quietly drop the boxes the user drew around the bug. */
  const lastPayload = useRef<ReportPayload | null>(null);

  // Only an admin can write app_config, so only an admin gets offered the setup button — a
  // regular user on a self-hosted install would just collect a 403. Mirrors Admin.tsx's
  // `operatorOnly`: off-demo every admin owns the relay, on the demo only the operator does.
  const canFixSmtp = !!user?.is_admin && (!demo || !!user?.is_super_admin);
  const needsConsent = !demo;
  const willSendShot = !!shot && includeShot;
  // Read-only accounts get no trigger at all — see canFileReport(). The same predicate hides the
  // FeedbackIconButton inside overlays, so there is no path left that ends in a dead "Senden".
  const canReport = canFileReport(user);
  // What identity travels with the report: the backend puts the user's e-mail (username as a
  // fallback) into the mail body AND its Reply-To. It is the one part of the payload the user
  // cannot see on screen, so the consent line has to name it.
  const fromId = user?.email || user?.username || (de ? 'anonym' : 'anonymous');

  const openReport = async () => {
    if (capturing) return;
    if (sentTimer.current) clearTimeout(sentTimer.current);
    setSent(false); setStoredOnly(false); setLost(false); setConsent(false); setIncludeShot(true);
    setSendReason(null); setError(null); lastPayload.current = null;
    // Ask up front whether mail can go out, so the notice is already on screen while the user
    // is still typing — not sprung on them after they hit Senden.
    void probeMail().then(setMail);
    setCapturing(true);
    try {
      const html2canvas = (await import('html2canvas')).default;
      const bg = getComputedStyle(document.body).backgroundColor;

      // The shot is exactly the viewport (x/y/width/height below), so anything scrolled out of
      // view cannot appear in it — but html2canvas still walks and clones the entire DOM before
      // cropping. On Warenstamm that is 467 article rows: measured 21s for a screenshot of the
      // ~10 rows you can actually see. Pruning off-screen elements takes the same capture to
      // 1.6s, and the output is pixel-identical because none of it was ever in frame.
      const vw = window.innerWidth, vh = window.innerHeight;
      const offscreen = (el: Element) => {
        const r = el.getBoundingClientRect();
        // A zero-box element is kept: it renders nothing itself but may still position children.
        if (!r.width && !r.height) return false;
        return r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw;
      };

      // Pre-decode the images we are allowed to read, keyed by src. Built from the LIVE document
      // (whose images are already decoded) and never written back to it — the user must not see
      // their page flicker while a screenshot is taken.
      // Order matters for cost: reject on origin and on visibility BEFORE allocating a canvas.
      // Cross-origin images taint the canvas and can never be read, so encoding them first and
      // catching the throw afterwards is pure waste — and on Warenstamm that is 467 of 468.
      const inlined = new Map<string, string>();
      for (const img of Array.from(document.images)) {
        if (!img.src || img.src.startsWith('data:') || inlined.has(img.src)) continue;
        let sameOrigin = false;
        try { sameOrigin = new URL(img.src, location.href).origin === location.origin; } catch { /* malformed */ }
        if (!sameOrigin) continue;
        if (offscreen(img)) continue;
        if (!img.naturalWidth || !img.naturalHeight) continue;
        try {
          const c = document.createElement('canvas');
          c.width = img.naturalWidth; c.height = img.naturalHeight;
          c.getContext('2d')?.drawImage(img, 0, 0);
          inlined.set(img.src, c.toDataURL('image/jpeg', 0.85));
        } catch { /* still unreadable for some other reason — simply absent */ }
      }

      const opts = {
        x: window.scrollX, y: window.scrollY,
        width: vw, height: vh,
        backgroundColor: bg && bg !== 'rgba(0, 0, 0, 0)' ? bg : '#ffffff',
        scale: Math.min(1, 1400 / vw),   // cap width so the payload stays small
        useCORS: true, logging: false,
        ignoreElements: (el: Element) =>
          el.hasAttribute('data-html2canvas-ignore') || offscreen(el),
        onclone: (doc: Document) => {
          doc.querySelectorAll('img').forEach(i => {
            const d = inlined.get(i.src);
            if (d) i.src = d;
          });
        },
      };

      // foreignObjectRendering hands layout back to the BROWSER instead of html2canvas's own
      // re-implementation of CSS. That re-implementation gets `overflow:hidden` text boxes
      // (Tailwind's `truncate`) wrong: the line boxes collapse, so a receipt card drew its
      // store name, date and price stacked on top of each other — the reported bug. Verified
      // against a native screenshot of the same page: this mode matches it exactly, including
      // the ellipsis, while the default mode overlaps.
      //
      // The cost is that nothing inside a foreignObject can hit the network, so only the
      // images inlined above survive. That is a smaller loss than it sounds: most cross-origin
      // product thumbnails already fail to draw in the default path, and a bug report needs
      // legible text far more than it needs a thumbnail.
      let canvas: HTMLCanvasElement;
      try {
        canvas = await html2canvas(document.body, { ...opts, foreignObjectRendering: true });
      } catch {
        // Some engines refuse the SVG/foreignObject path outright. A screenshot with bad text
        // beats no screenshot, and the report still sends without one.
        canvas = await html2canvas(document.body, { ...opts, foreignObjectRendering: false });
      }
      setShot(canvas.toDataURL('image/jpeg', 0.85));
    } catch { setShot(null); /* degrade to text-only */ }
    setCapturing(false);
    setOpen(true);
  };

  // Full-screen overlays (Modal, Tour, Onboarding, …) paint over both triggers, so from
  // inside one neither is clickable. Their chrome carries a FeedbackIconButton that fires
  // this bus instead — same pattern as 'vds:open-tour'. Only the header variant listens: it
  // exists in every build, while on the demo BOTH variants are mounted and two listeners
  // would capture twice and stack two report modals on one click.
  // canReport is in here too: the component returns null further down for read-only accounts, so
  // a stray bus event would otherwise screenshot the page into a modal that never renders.
  useEffect(() => {
    if (variant !== 'header' || !canReport) return;
    const onBus = () => { if (!open) void openReport(); };
    window.addEventListener('vds:open-report', onBus);
    return () => window.removeEventListener('vds:open-report', onBus);
  }, [variant, open, capturing, canReport]);

  const close = () => {
    if (sentTimer.current) clearTimeout(sentTimer.current);
    setOpen(false); setShot(null); setMsg(''); setSent(false);
    setStoredOnly(false); setLost(false); setConsent(false); setSmtpOpen(false); setMail(null);
    setSendReason(null); setError(null); lastPayload.current = null;
  };

  // Back from SMTP setup — either path, saved or cancelled. The report itself is untouched
  // (it never unmounted); only the mail verdict is re-read, so a successful setup makes the
  // notice disappear without the user having to close and rewrite what they were typing.
  const closeSmtp = () => { setSmtpOpen(false); void probeMail().then(setMail); };

  // This dialog is opened ON TOP of whatever it is reporting, so Escape must dismiss IT and
  // leave the overlay underneath (and its unsaved form state) alone.
  useEscapeLayer(open, close);
  useScrollLock(open);

  /** The one POST, shared by "Senden" and the "Erneut senden" on the failed endings. */
  const send = async (payload: ReportPayload) => {
    setSending(true); setError(null);
    try {
      // The POST is the authority on what happened: the backend awaits the actual send and
      // answers stored/mailed/reason, so the confirmation can state the truth instead of a
      // hopeful "ist angekommen". A backend that predates the fields says nothing — then fall
      // back to the old wording rather than accusing a working install of swallowing reports.
      const res = await api<{ stored?: boolean; mailed?: boolean; reason?: string | null }>('/api/bug-reports', { method: 'POST', body: payload });
      const mailed = res?.mailed;
      const failed = mailed === false;
      const kept = res?.stored !== false;
      const why = res?.reason ?? null;
      const smtpReason = why === 'smtp_failed' || why === 'smtp_unconfigured' ? why : null;
      // Only an SMTP verdict may move the mail banner — and it beats the reason we probed
      // earlier, so a "stored only" ending cannot downgrade "the server refuses mail" to
      // "nothing set up". A report refused for a missing tick (a stale tab) says nothing about
      // whether this box can send at all and must not relabel a working relay as broken.
      if (mailed === true || smtpReason) setMail({ ok: mailed === true, reason: smtpReason });
      setSendReason(why);
      setStoredOnly(failed && kept);
      setLost(failed && !kept);
      setSent(true);
      // Auto-dismiss only the happy path, and clear the text only there. The failed endings carry
      // a next step (set up e-mail, ask your admin, try again) and have to survive long enough to
      // be read — wiping what the user wrote would mean retyping the whole report from memory the
      // moment the admin has fixed the mail server two clicks away.
      if (!failed) {
        setMsg('');
        sentTimer.current = setTimeout(() => { setOpen(false); setSent(false); setShot(null); }, 1700);
      }
    } catch (e) {
      // Never silently: a Senden that does nothing is indistinguishable from a broken app. 429
      // (hourly limit) and 403 (read-only account) come back as finished German sentences written
      // for the user; anything else is a bare status line or a dead connection, which only our
      // own wording can explain.
      const status = e instanceof ApiError ? e.status : 0;
      const detail = (e as Error)?.message || String(status || '');
      setError(status === 429 || status === 403 ? detail : t('bugReport.sendFailed', { detail }));
    } finally { setSending(false); }
  };

  const submit = async () => {
    if (!msg.trim() || sending || (needsConsent && !consent)) return;
    const screenshot = willSendShot ? (annot.current?.getMerged() ?? shot ?? undefined) : undefined;
    const payload: ReportPayload = {
      message: msg, page: pathname, screenshot_base64: screenshot,
      // The tick has to travel WITH the report: the forward is gated on it server-side, because a
      // consent that stayed in the browser is no consent at all once an older client posts the
      // pre-tick body. Only where the tick is actually shown — on the demo the field would assert
      // an agreement nobody was asked for.
      ...(needsConsent ? { consent } : {}),
    };
    lastPayload.current = payload;
    await send(payload);
  };

  // Resend the same body, same consent: the user agreed to exactly this payload, and asking again
  // after their admin fixed the mail server would cost them the report they already wrote.
  const retry = () => { if (lastPayload.current) void send(lastPayload.current); };
  // Only where it could end differently: mail became possible (SMTP was just set up behind this
  // dialog), or nothing was stored either, so trying again is the only thing left. A client that
  // sent no tick cannot fix that by retrying — it has to be reloaded.
  const canRetry = !!lastPayload.current && sendReason !== 'consent_missing' && (lost || mail?.ok === true);

  if (!canReport) return null;   // after every hook — see canReport above

  const title = de ? 'Fehler / Feedback melden' : 'Report a bug / feedback';
  const toolBtn = 'flex h-8 w-8 items-center justify-center rounded-lg border text-zinc-600 dark:text-zinc-300';
  return (
    <>
      {variant === 'header' ? (
        <button
          data-html2canvas-ignore onClick={openReport} disabled={capturing}
          title={title} aria-label={title}
          className="flex h-9 w-9 items-center justify-center rounded-xl text-red-500 transition-colors hover:bg-red-50 hover:text-red-600 dark:text-red-400 dark:hover:bg-red-950/40 dark:hover:text-red-300"
        >
          {capturing ? <Loader2 size={18} className="animate-spin" /> : <Bug size={18} />}
        </button>
      ) : (
        <button
          data-html2canvas-ignore onClick={openReport} disabled={capturing}
          title={title}
          className="fixed bottom-20 left-3 z-40 flex items-center gap-1.5 rounded-full border border-red-300 bg-white/95 px-3 py-2 text-xs font-medium text-red-600 shadow-lg backdrop-blur transition-colors hover:border-red-400 hover:text-red-700 dark:border-red-900 dark:bg-zinc-900/95 dark:text-red-400 dark:hover:text-red-300 md:bottom-4"
        >
          {capturing ? <Loader2 size={15} className="animate-spin" /> : <Bug size={15} />} Feedback
        </button>
      )}

      {/* Above EVERY other layer (toast 100, emoji picker 70, tour/onboarding 60, modal 50):
          it is opened from inside those, and the toast stack in particular sits exactly on
          the Senden/Abbrechen row on a phone and swallowed the tap. */}
      {open && createPortal(
        <div data-html2canvas-ignore className="fixed inset-0 z-[110] flex items-end justify-center bg-black/40 p-4 sm:items-center" onClick={close}>
          <div className="max-h-[92vh] w-full max-w-md overflow-y-auto rounded-2xl bg-white p-5 shadow-xl dark:bg-zinc-900" onClick={e => e.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-base font-bold"><Bug size={18} /> {title}</h2>
              <button onClick={close} className="rounded-lg p-1 text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800"><X size={18} /></button>
            </div>
            {sent ? (
              storedOnly || lost ? (
                // Honest ending. storedOnly: the row is in bug_report, but nobody was mailed —
                // say so, and give the one person who can change that (the admin) the way to.
                // lost: not even the row survived, so "liegt auf diesem Server" would be a lie.
                <div className="py-4 text-center">
                  <p className="text-sm font-medium">{t(lost ? 'bugReport.lostTitle' : 'bugReport.storedTitle')}</p>
                  <p className="mt-1.5 text-xs text-zinc-500 dark:text-zinc-400">
                    {lost
                      ? t('bugReport.lostBody', { mail: DEV_MAIL })
                      : sendReason === 'consent_missing'
                        ? t('bugReport.storedStale')
                        : canFixSmtp ? t('bugReport.storedAdmin') : t('bugReport.storedUser')}
                  </p>
                  {error && <p className="mt-2 text-xs font-medium text-red-500">{error}</p>}
                  <div className="mt-4 flex flex-wrap justify-center gap-2">
                    {canRetry && <Button variant="secondary" disabled={sending} onClick={retry}>{sending ? '…' : t('bugReport.retry')}</Button>}
                    {canFixSmtp && sendReason !== 'consent_missing' && <Button variant="secondary" onClick={() => setSmtpOpen(true)}>{t('bugReport.setupMail')}</Button>}
                    <Button onClick={close}>{t('common.close')}</Button>
                  </div>
                </div>
              ) : (
                <p className="py-6 text-center text-sm font-medium text-emerald-600">{de ? 'Danke! Deine Meldung ist angekommen. 🙏' : 'Thanks! Your report was received. 🙏'}</p>
              )
            ) : (
              <>
                {mail && !mail.ok && (
                  <div className="mb-3 flex flex-col gap-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs leading-relaxed text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                    <p className="flex items-start gap-1.5">
                      <MailWarning size={14} className="mt-0.5 shrink-0" />
                      <span>{t(mail.reason === 'smtp_failed' ? 'bugReport.noMailBroken' : 'bugReport.noMail', { mail: DEV_MAIL })}</span>
                    </p>
                    {canFixSmtp
                      ? <Button variant="secondary" className="self-start" onClick={() => setSmtpOpen(true)}>{t('bugReport.setupMail')}</Button>
                      : <p>{t('bugReport.noMailUser')}</p>}
                  </div>
                )}
                {shot && (
                  <>
                    {/* Hidden, not unmounted: ShotAnnotator keeps the drawn shapes in a ref, so
                        dropping the screenshot and putting it back must not cost the user the
                        boxes they already drew around the bug. */}
                    <div className={willSendShot ? undefined : 'hidden'}>
                      <div className="mb-2 flex items-center gap-1.5">
                        <button onClick={() => setTool('pen')} title={de ? 'Stift' : 'Pen'}
                          className={`${toolBtn} ${tool === 'pen' ? 'border-emerald-500 text-emerald-600' : 'border-zinc-300 dark:border-zinc-700'}`}><Pencil size={15} /></button>
                        <button onClick={() => setTool('box')} title={de ? 'Kästchen' : 'Box'}
                          className={`${toolBtn} ${tool === 'box' ? 'border-emerald-500 text-emerald-600' : 'border-zinc-300 dark:border-zinc-700'}`}><Square size={15} /></button>
                        <span className="mx-1 h-5 w-px bg-zinc-200 dark:bg-zinc-700" />
                        {COLORS.map(c => (
                          <button key={c} onClick={() => setColor(c)} aria-label={c}
                            className={`h-6 w-6 rounded-full border-2 ${color === c ? 'border-zinc-900 dark:border-white' : 'border-zinc-200 dark:border-zinc-700'}`}
                            style={{ background: c }} />
                        ))}
                        <span className="flex-1" />
                        <button onClick={() => annot.current?.undo()} title={de ? 'Rückgängig' : 'Undo'} className={`${toolBtn} border-zinc-300 dark:border-zinc-700`}><Undo2 size={15} /></button>
                        <button onClick={() => annot.current?.clear()} title={de ? 'Löschen' : 'Clear'} className={`${toolBtn} border-zinc-300 dark:border-zinc-700`}><Trash2 size={15} /></button>
                      </div>
                      <ShotAnnotator ref={annot} shot={shot} color={color} tool={tool} />
                      <p className="mb-2 mt-1 text-[11px] text-zinc-400">{de ? 'Markiere den Fehler direkt im Bild.' : 'Mark the problem right on the image.'}</p>
                    </div>
                    {/* The escape hatch that makes the consent real: a layout bug can be
                        reported in words without shipping a picture of somebody's receipts. */}
                    <div className="mb-2 flex items-center justify-between gap-2 text-[11px] text-zinc-500 dark:text-zinc-400">
                      <span>{willSendShot ? t('bugReport.shotIncluded') : t('bugReport.shotRemoved')}</span>
                      <button
                        type="button"
                        // Locked while the POST is in flight: the payload was frozen before the
                        // await, so toggling here would flip the line next to it to "Screenshot
                        // entfernt" for an image that is already on the wire.
                        disabled={sending}
                        // Any change to WHAT leaves the box invalidates a tick that described
                        // the old payload — so the user re-confirms what they are now sending.
                        onClick={() => { setIncludeShot(v => !v); setConsent(false); }}
                        className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-zinc-300 px-2 py-1 font-medium text-zinc-600 hover:border-zinc-400 disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300"
                      >
                        {willSendShot ? <><ImageOff size={12} /> {t('bugReport.removeShot')}</> : <><ImagePlus size={12} /> {t('bugReport.restoreShot')}</>}
                      </button>
                    </div>
                  </>
                )}
                <p className="mb-2 text-xs text-zinc-500">{willSendShot ? t('bugReport.promptWithShot') : t('bugReport.promptTextOnly')}</p>
                <textarea
                  value={msg} onChange={e => setMsg(e.target.value)} rows={3} autoFocus
                  placeholder={de ? 'Beschreibe kurz den Fehler oder deine Idee…' : 'Briefly describe the bug or your idea…'}
                  className="w-full resize-none rounded-xl border border-zinc-300 bg-zinc-50 p-3 text-sm outline-none focus:border-emerald-500 dark:border-zinc-700 dark:bg-zinc-800"
                />
                {needsConsent && (
                  <label className="mt-3 flex cursor-pointer items-start gap-2 text-xs leading-relaxed text-zinc-600 dark:text-zinc-300">
                    <input
                      type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)}
                      // Same reason as the screenshot toggle: once the POST is out, un-ticking
                      // here would show a withdrawal that never reached the server.
                      disabled={sending}
                      className="mt-0.5 h-4 w-4 shrink-0 accent-emerald-600 disabled:opacity-40"
                    />
                    <span>{t(willSendShot ? 'bugReport.consentWithShot' : 'bugReport.consentTextOnly', { mail: DEV_MAIL, from: fromId })}</span>
                  </label>
                )}
                {error && <p className="mt-2 text-xs font-medium text-red-500">{error}</p>}
                <div className="mt-3 flex justify-end gap-2">
                  <button onClick={close} className="rounded-xl px-3 py-2 text-sm font-medium text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800">{de ? 'Abbrechen' : 'Cancel'}</button>
                  <button onClick={submit} disabled={!msg.trim() || sending || (needsConsent && !consent)} className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-40">{sending ? '…' : (de ? 'Senden' : 'Send')}</button>
                </div>
              </>
            )}
          </div>
        </div>,
        document.body,
      )}

      {/* Its own portal, NOT nested inside the report's overlay: that overlay closes the report
          on any backdrop click, which would tear down the half-written report the moment the
          user clicked next to the setup dialog. */}
      {smtpOpen && createPortal(<SmtpSetupDialog onClose={closeSmtp} />, document.body)}
    </>
  );
}
