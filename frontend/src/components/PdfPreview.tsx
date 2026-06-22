import { useEffect, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { FileText } from 'lucide-react';

// Worker resolved by Vite to a hashed asset URL at build time.
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();

/** Renders a PDF to <canvas> via pdf.js — independent of the browser's native PDF
 *  handling, so it shows even when "download PDFs instead of opening" is enabled.
 *  maxPages=1 → a thumbnail (first page); larger → the full, scrollable document. */
export function PdfPreview({ url, maxPages = 99, className }: { url: string; maxPages?: number; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let task: ReturnType<typeof pdfjsLib.getDocument> | null = null;
    const host = ref.current;
    if (!host) return;
    setFailed(false);
    (async () => {
      try {
        task = pdfjsLib.getDocument({ url });
        const doc = await task.promise;
        if (cancelled) return;
        host.replaceChildren();
        const width = Math.max(120, host.clientWidth || 300);
        const dpr = window.devicePixelRatio || 1;
        const n = Math.min(maxPages, doc.numPages);
        for (let i = 1; i <= n; i++) {
          const page = await doc.getPage(i);
          if (cancelled) return;
          const base = page.getViewport({ scale: 1 });
          const vp = page.getViewport({ scale: (width / base.width) * dpr });
          const canvas = document.createElement('canvas');
          canvas.width = vp.width;
          canvas.height = vp.height;
          canvas.style.width = '100%';
          canvas.style.display = 'block';
          if (i > 1) canvas.style.marginTop = '8px';
          host.appendChild(canvas);
          await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport: vp }).promise;
          if (cancelled) return;
        }
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => { cancelled = true; void task?.destroy?.(); };
  }, [url, maxPages]);

  if (failed) {
    return (
      <div className="flex h-full w-full items-center justify-center text-zinc-400">
        <FileText size={20} />
      </div>
    );
  }
  return <div ref={ref} className={className} />;
}
