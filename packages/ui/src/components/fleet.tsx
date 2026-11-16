import { Fragment, useRef, useState, type DragEvent, type KeyboardEvent, type PointerEvent } from 'react';
import { Columns2 } from 'lucide-react';
import { useAxo } from '../stores/store.ts';
import { MAX_PANES } from '../lib/layout.ts';
import { endAgentDrag, isAgentDrag, readAgentDrop, useDrag } from '../lib/dnd.ts';
import { ChatPane, Empty } from './chat-pane.tsx';
import { cn, Kbd } from './ui.tsx';

/** Fleet: 1–3 chat panes side by side with resizable dividers. */
export function Fleet() {
  const layout = useAxo((s) => s.layout);
  const openInSplit = useAxo((s) => s.openInSplit);
  const dragging = useDrag((s) => s.agent);
  const row = useRef<HTMLDivElement>(null);
  const multi = layout.panes.length > 1;
  const canSplit = layout.panes.length < MAX_PANES && layout.panes.every(Boolean);

  return (
    <div ref={row} className="relative flex h-full min-w-0 flex-1">
      {layout.panes.map((sel, i) => (
        <Fragment key={sel ? `${sel.nodeKey}:${sel.agentId}` : `empty-${i}`}>
          {i > 0 && <Divider index={i - 1} row={row} />}
          <PaneSlot index={i} grow={layout.sizes[i]}>
            {sel ? (
              <ChatPane sel={sel} index={i} focused={layout.focused === i} multi={multi} />
            ) : (
              <Empty text="Drag an agent here, or pick one in the sidebar.">
                <span className="text-xs text-faint">⌘-click an agent to open it in a split · <Kbd>⌘K</Kbd> to jump</span>
              </Empty>
            )}
          </PaneSlot>
        </Fragment>
      ))}
      {dragging && canSplit && <SplitDropZone onDrop={(sel) => { endAgentDrag(); openInSplit(sel); }} />}
    </div>
  );
}

function PaneSlot({ index, grow, children }: { index: number; grow: number; children: React.ReactNode }) {
  const focusPane = useAxo((s) => s.focusPane);
  const openInPane = useAxo((s) => s.openInPane);
  const dragging = useDrag((s) => !!s.agent);
  const [over, setOver] = useState(false);

  const onDragOver = (e: DragEvent) => {
    if (!isAgentDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setOver(true);
  };
  const onDrop = (e: DragEvent) => {
    setOver(false);
    const sel = readAgentDrop(e);
    endAgentDrag();
    if (!sel) return;
    e.preventDefault();
    openInPane(sel, index);
  };

  return (
    <div
      data-pane={index}
      className="@container relative flex h-full min-w-0 flex-col"
      style={{ flex: `${grow} 1 0%` }}
      onMouseDownCapture={() => focusPane(index)}
      onFocusCapture={() => focusPane(index)}
      onDragOver={onDragOver}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(false); }}
      onDrop={onDrop}
    >
      {children}
      {dragging && (
        <div className={cn('pointer-events-none absolute inset-2 z-30 flex items-center justify-center rounded-lg border-2 border-dashed text-xs font-medium transition-colors',
          over ? 'border-accent bg-accent/10 text-primary' : 'border-border text-transparent')}>
          Show here
        </div>
      )}
    </div>
  );
}

function SplitDropZone({ onDrop }: { onDrop: (sel: NonNullable<ReturnType<typeof readAgentDrop>>) => void }) {
  const [over, setOver] = useState(false);
  return (
    <div
      className={cn('absolute inset-y-2 right-2 z-40 flex w-28 flex-col items-center justify-center gap-1.5 rounded-lg border-2 border-dashed text-xs font-medium transition-colors',
        over ? 'border-accent bg-accent/15 text-primary' : 'border-border-strong bg-elevated/90 text-muted')}
      onDragOver={(e) => { if (isAgentDrag(e)) { e.preventDefault(); e.stopPropagation(); setOver(true); } }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); e.stopPropagation(); setOver(false); const sel = readAgentDrop(e); if (sel) onDrop(sel); else endAgentDrag(); }}
    >
      <Columns2 size={16} />
      New split
    </div>
  );
}

const KEY_STEP = 0.03;

function Divider({ index, row }: { index: number; row: React.RefObject<HTMLDivElement | null> }) {
  const resize = useAxo((s) => s.resizePanes);
  const reset = useAxo((s) => s.resetPaneSizes);
  const left = useAxo((s) => s.layout.sizes[index]);
  const last = useRef<number | null>(null);
  const [active, setActive] = useState(false);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    last.current = e.clientX;
    setActive(true);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (last.current == null || !row.current) return;
    const dx = e.clientX - last.current;
    last.current = e.clientX;
    if (dx) resize(index, dx / row.current.clientWidth);
  };
  const end = () => { last.current = null; setActive(false); };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowLeft') { e.preventDefault(); resize(index, -KEY_STEP); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); resize(index, KEY_STEP); }
    else if (e.key === 'Enter' || e.key === 'Home') { e.preventDefault(); reset(); }
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize panes"
      aria-valuenow={Math.round(left * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={reset}
      onKeyDown={onKeyDown}
      className="group relative z-20 w-px shrink-0 cursor-col-resize bg-border-subtle outline-none"
    >
      {/* Wider invisible hit area; the visible line brightens on hover/drag/focus. */}
      <span className="absolute inset-y-0 -left-[3px] -right-[3px]" />
      <span className={cn('absolute inset-y-0 -left-px -right-px transition-colors group-hover:bg-border-strong group-focus-visible:bg-accent', active && 'bg-accent')} />
    </div>
  );
}
