// PDF via pdf.js. Lazy-loaded (pdf.js is large); pages render as they scroll into view.
import { useEffect, useRef, useState } from 'react';
import { ZoomIn, ZoomOut } from 'lucide-react';
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist';
import workerSource from 'pdfjs-dist/build/pdf.worker.min.mjs?raw';
import { IconButton } from '../ui.tsx';
import { Centered } from './media-viewer.tsx';

// The worker runs from a Blob URL: a separate worker file can't be loaded reliably from file://.
GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }));

const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];

export default function PdfViewer({ url }: { url: string }) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(2); // index into ZOOMS → 1.0

  useEffect(() => {
    setDoc(null);
    setError(null);
    const task = getDocument({ url });
    task.promise.then(setDoc, (e: Error) => setError(e.message));
    return () => { void task.destroy(); };
  }, [url]);

  if (error) return <Centered>Couldn't open this PDF: {error}</Centered>;
  if (!doc) return <Centered>Loading PDF…</Centered>;

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border-subtle px-3 text-2xs text-faint">
        <span>{doc.numPages} page{doc.numPages === 1 ? '' : 's'}</span>
        <div className="ml-auto flex items-center gap-1">
          <IconButton title="Zoom out" disabled={zoom === 0} onClick={() => setZoom(zoom - 1)}><ZoomOut size={13} /></IconButton>
          <span className="w-10 text-center font-mono">{Math.round(ZOOMS[zoom] * 100)}%</span>
          <IconButton title="Zoom in" disabled={zoom === ZOOMS.length - 1} onClick={() => setZoom(zoom + 1)}><ZoomIn size={13} /></IconButton>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto bg-inset py-4">
        {Array.from({ length: doc.numPages }, (_, i) => <Page key={i} doc={doc} n={i + 1} scale={ZOOMS[zoom]} />)}
      </div>
    </div>
  );
}

function Page({ doc, n, scale }: { doc: PDFDocumentProxy; n: number; scale: number }) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(n <= 2);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) setVisible(true); }, { rootMargin: '600px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    let render: { cancel(): void } | null = null;
    void doc.getPage(n).then((page) => {
      if (cancelled) return;
      const vp = page.getViewport({ scale });
      setSize({ w: vp.width, h: vp.height });
      if (!visible || !canvas.current) return;
      const dpr = window.devicePixelRatio || 1;
      const c = canvas.current;
      c.width = Math.floor(vp.width * dpr);
      c.height = Math.floor(vp.height * dpr);
      c.style.width = `${vp.width}px`;
      c.style.height = `${vp.height}px`;
      const task = page.render({ canvas: c, viewport: vp, transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0] });
      render = task;
      task.promise.catch(() => { /* cancelled */ });
    });
    return () => { cancelled = true; render?.cancel(); };
  }, [doc, n, scale, visible]);

  return (
    <div ref={box} className="mx-auto mb-4 bg-white shadow-pop" style={size ? { width: size.w, height: size.h } : { width: 600 * scale, height: 800 * scale }}>
      <canvas ref={canvas} aria-label={`Page ${n}`} />
    </div>
  );
}
