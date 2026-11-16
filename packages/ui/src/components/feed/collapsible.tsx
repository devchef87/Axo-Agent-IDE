import { useRef, useState } from 'react';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { foldText } from '../../lib/collapse.ts';
import { tryClient } from '../../stores/store.ts';
import { cn, useModalFocus } from '../ui.tsx';
import { useFeedContext } from './feed-context.ts';

/** Long text folded to its first lines with a "Show all N lines" toggle. */
export function Collapsible({ text, className, as = 'pre' }: { text: string; className?: string; as?: 'pre' | 'div' }) {
  const [open, setOpen] = useState(false);
  const folded = foldText(text);
  const Tag = as;
  if (!folded) return <Tag className={className}>{text}</Tag>;
  return (
    <div>
      <Tag className={cn(className, !open && 'relative')}>
        {open ? text : folded.head}
        {!open && as === 'pre' && <span className="pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-gradient-to-t from-[var(--inset)] to-transparent" aria-hidden />}
      </Tag>
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="mt-1 flex items-center gap-1 rounded px-1 text-2xs text-muted hover:bg-hover hover:text-primary cursor-pointer"
      >
        {open ? <><ChevronUp size={11} /> Collapse</> : <><ChevronDown size={11} /> Show all {folded.totalLines} lines</>}
      </button>
    </div>
  );
}

export function imageUrl(nodeKey: string, agentId: string, imageId: string): string {
  const c = tryClient(nodeKey);
  if (!c) return '';
  const conn = c.conn;
  return `${conn.baseUrl}/api/agents/${agentId}/images/${encodeURIComponent(imageId)}?token=${encodeURIComponent(conn.token)}`;
}

/** Thumbnails of images a tool returned; click for a full-size view. */
export function ImageStrip({ images }: { images: { id: string; mediaType: string }[] }) {
  const ctx = useFeedContext();
  const [open, setOpen] = useState<string | null>(null);
  if (!ctx || !images.length) return null;
  const url = (id: string) => imageUrl(ctx.nodeKey, ctx.agentId, id);
  return (
    <div className="my-1.5 ml-6 flex flex-wrap gap-2">
      {images.map((img) => (
        <button
          key={img.id}
          onClick={() => setOpen(img.id)}
          title="Open full size"
          className="checkerboard overflow-hidden rounded-md border border-border-subtle hover:border-border-strong cursor-zoom-in"
        >
          <img src={url(img.id)} alt="Tool result image" loading="lazy" className="block max-h-40 max-w-72 object-contain" />
        </button>
      ))}
      {open && <Lightbox src={url(open)} onClose={() => setOpen(null)} />}
    </div>
  );
}

function Lightbox({ src, onClose }: { src: string; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useModalFocus(ref, true, onClose);
  return (
    <div className="no-drag fixed inset-0 z-50 flex items-center justify-center bg-[var(--overlay)] p-8" onMouseDown={onClose}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label="Image" tabIndex={-1} className="relative outline-none" onMouseDown={(e) => e.stopPropagation()}>
        <button onClick={onClose} aria-label="Close" className="absolute -right-3 -top-3 flex h-7 w-7 items-center justify-center rounded-full border border-border bg-elevated text-secondary shadow-pop hover:text-primary cursor-pointer">
          <X size={14} />
        </button>
        <div className="checkerboard overflow-auto rounded-md shadow-pop" style={{ maxWidth: 'calc(100vw - 4rem)', maxHeight: 'calc(100vh - 4rem)' }}>
          <img src={src} alt="Tool result image, full size" className="block" />
        </div>
      </div>
    </div>
  );
}
