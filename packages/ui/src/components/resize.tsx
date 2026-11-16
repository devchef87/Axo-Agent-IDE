import { useCallback, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { cn } from './ui.tsx';

/** A side panel's width, persisted per id. */
export function usePanelWidth(id: string, initial: number, min: number, max: number) {
  const key = `axo.panel.${id}`;
  const read = () => { const v = Number(localStorage.getItem(key)); return v >= min && v <= max ? v : initial; };
  const [state, setState] = useState(() => ({ key, width: read() }));
  // Switching id (e.g. the sidebar's editor vs fleet width) loads that id's width.
  const width = state.key === key ? state.width : read();
  const set = useCallback((w: number) => {
    const v = Math.round(Math.min(max, Math.max(min, w)));
    localStorage.setItem(key, String(v));
    setState({ key, width: v });
  }, [key, min, max]);
  const reset = useCallback(() => { localStorage.removeItem(key); setState({ key, width: initial }); }, [key, initial]);
  return { width, set, reset };
}

/**
 * Vertical drag handle on a panel's edge. `edge` is the side of the panel it sits on: a left
 * sidebar's handle is on its right edge (dragging right grows it), a right drawer's on its left.
 */
export function ResizeHandle({ edge, width, onResize, onReset, label }: {
  edge: 'left' | 'right'; width: number; onResize(w: number): void; onReset(): void; label: string;
}) {
  const [dragging, setDragging] = useState(false);
  const dir = edge === 'right' ? 1 : -1;
  const start = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const x0 = e.clientX, w0 = width;
    setDragging(true);
    const move = (ev: PointerEvent) => onResize(w0 + (ev.clientX - x0) * dir);
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      document.body.style.cursor = ''; document.body.style.userSelect = '';
      setDragging(false);
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    onResize(width + (e.key === 'ArrowRight' ? 16 : -16) * dir);
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      onPointerDown={start}
      onDoubleClick={onReset}
      onKeyDown={onKey}
      className={cn('group absolute inset-y-0 z-20 w-[7px] cursor-col-resize outline-none', edge === 'right' ? '-right-[4px]' : '-left-[4px]')}
    >
      <span className={cn('absolute inset-y-0 left-[3px] w-px transition-colors',
        dragging ? 'bg-border-strong' : 'group-hover:bg-border-strong/70 group-focus-visible:bg-border-strong')} aria-hidden />
    </div>
  );
}
