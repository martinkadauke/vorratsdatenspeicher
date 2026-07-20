import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Bug, X, Pencil, Square, Undo2, Trash2, Loader2 } from 'lucide-react';
import { api } from '../api/client';

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

/** Feedback / bug report. Two placements share one modal:
 *  - variant="header": a small icon button for the top bar, present in ALL builds.
 *  - variant="floating" (default): the demo's bottom-left floating pill.
 *  On open it screenshots the current view (html2canvas, loaded on demand); the
 *  user can draw / box on it, and the annotated image + page + household go along. */
export function BugReportButton({ variant = 'floating' }: { variant?: 'floating' | 'header' } = {}) {
  const { i18n } = useTranslation();
  const de = i18n.language.startsWith('de');
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [shot, setShot] = useState<string | null>(null);
  const [tool, setTool] = useState<'pen' | 'box'>('box');
  const [color, setColor] = useState(COLORS[0]);
  const [msg, setMsg] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const annot = useRef<AnnotatorHandle>(null);
  const sentTimer = useRef<ReturnType<typeof setTimeout>>();

  const openReport = async () => {
    if (capturing) return;
    if (sentTimer.current) clearTimeout(sentTimer.current);
    setSent(false);
    setCapturing(true);
    try {
      const html2canvas = (await import('html2canvas')).default;
      const bg = getComputedStyle(document.body).backgroundColor;
      const canvas = await html2canvas(document.body, {
        x: window.scrollX, y: window.scrollY,
        width: window.innerWidth, height: window.innerHeight,
        backgroundColor: bg && bg !== 'rgba(0, 0, 0, 0)' ? bg : '#ffffff',
        scale: Math.min(1, 1400 / window.innerWidth),   // cap width so the payload stays small
        useCORS: true, logging: false,
        ignoreElements: el => el.hasAttribute('data-html2canvas-ignore'),
      });
      setShot(canvas.toDataURL('image/jpeg', 0.85));
    } catch { setShot(null); /* degrade to text-only */ }
    setCapturing(false);
    setOpen(true);
  };

  const close = () => {
    if (sentTimer.current) clearTimeout(sentTimer.current);
    setOpen(false); setShot(null); setMsg(''); setSent(false);
  };

  const submit = async () => {
    if (!msg.trim() || sending) return;
    setSending(true);
    try {
      const screenshot = annot.current?.getMerged() ?? shot ?? undefined;
      await api('/api/bug-reports', { method: 'POST', body: { message: msg, page: pathname, screenshot_base64: screenshot } });
      setSent(true); setMsg('');
      sentTimer.current = setTimeout(() => { setOpen(false); setSent(false); setShot(null); }, 1700);
    } catch { /* swallow — feedback should never surface an error */ } finally { setSending(false); }
  };

  const title = de ? 'Fehler / Feedback melden' : 'Report a bug / feedback';
  const toolBtn = 'flex h-8 w-8 items-center justify-center rounded-lg border text-zinc-600 dark:text-zinc-300';
  return (
    <>
      {variant === 'header' ? (
        <button
          data-html2canvas-ignore onClick={openReport} disabled={capturing}
          title={title} aria-label={title}
          className="flex h-9 w-9 items-center justify-center rounded-xl text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-emerald-600 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-emerald-400"
        >
          {capturing ? <Loader2 size={18} className="animate-spin" /> : <Bug size={18} />}
        </button>
      ) : (
        <button
          data-html2canvas-ignore onClick={openReport} disabled={capturing}
          title={title}
          className="fixed bottom-20 left-3 z-40 flex items-center gap-1.5 rounded-full border border-zinc-300 bg-white/95 px-3 py-2 text-xs font-medium text-zinc-600 shadow-lg backdrop-blur transition-colors hover:text-emerald-600 dark:border-zinc-700 dark:bg-zinc-900/95 dark:text-zinc-300 dark:hover:text-emerald-400 md:bottom-4"
        >
          {capturing ? <Loader2 size={15} className="animate-spin" /> : <Bug size={15} />} Feedback
        </button>
      )}

      {open && createPortal(
        <div data-html2canvas-ignore className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center" onClick={close}>
          <div className="max-h-[92vh] w-full max-w-md overflow-y-auto rounded-2xl bg-white p-5 shadow-xl dark:bg-zinc-900" onClick={e => e.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-base font-bold"><Bug size={18} /> {title}</h2>
              <button onClick={close} className="rounded-lg p-1 text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800"><X size={18} /></button>
            </div>
            {sent ? (
              <p className="py-6 text-center text-sm font-medium text-emerald-600">{de ? 'Danke! Deine Meldung ist angekommen. 🙏' : 'Thanks! Your report was received. 🙏'}</p>
            ) : (
              <>
                {shot && (
                  <>
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
                  </>
                )}
                <p className="mb-2 text-xs text-zinc-500">{de ? 'Was ist passiert? (Seite & Screenshot werden mitgeschickt)' : 'What happened? (page & screenshot are included)'}</p>
                <textarea
                  value={msg} onChange={e => setMsg(e.target.value)} rows={3} autoFocus
                  placeholder={de ? 'Beschreibe kurz den Fehler oder deine Idee…' : 'Briefly describe the bug or your idea…'}
                  className="w-full resize-none rounded-xl border border-zinc-300 bg-zinc-50 p-3 text-sm outline-none focus:border-emerald-500 dark:border-zinc-700 dark:bg-zinc-800"
                />
                <div className="mt-3 flex justify-end gap-2">
                  <button onClick={close} className="rounded-xl px-3 py-2 text-sm font-medium text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800">{de ? 'Abbrechen' : 'Cancel'}</button>
                  <button onClick={submit} disabled={!msg.trim() || sending} className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-40">{sending ? '…' : (de ? 'Senden' : 'Send')}</button>
                </div>
              </>
            )}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
