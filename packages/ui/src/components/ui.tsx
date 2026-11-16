import { clsx } from 'clsx';
import { useEffect, useId, useRef, type ButtonHTMLAttributes, type ReactNode, type RefObject } from 'react';
import { X } from 'lucide-react';
import type { AgentStatus } from '@axo/protocol';
import type { ConnStatus } from '../lib/client.ts';

export const cn = clsx;

type Variant = 'primary' | 'ghost' | 'danger' | 'subtle';
export function Button({ variant = 'subtle', size = 'md', className, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' }) {
  return (
    <button
      {...p}
      className={cn(
        'inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded font-medium transition-colors disabled:opacity-40 disabled:pointer-events-none cursor-pointer',
        size === 'sm' ? 'h-6 px-2 text-xs' : 'h-7 px-3 text-xs',
        variant === 'primary' && 'bg-accent text-accent-fg hover:bg-accent-hover',
        variant === 'subtle' && 'border border-border bg-transparent text-secondary hover:border-border-strong hover:text-primary',
        variant === 'ghost' && 'text-muted hover:text-primary hover:bg-hover',
        variant === 'danger' && 'border border-danger/40 text-danger hover:bg-danger/10',
        className,
      )}
    />
  );
}

export function IconButton({ className, title, ...p }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...p}
      title={title}
      aria-label={title}
      className={cn('inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-faint hover:bg-hover hover:text-primary transition-colors cursor-pointer disabled:opacity-40 [&_svg]:stroke-[1.75]', className)}
    />
  );
}

const STATUS_COLOR: Record<AgentStatus, string> = {
  working: 'bg-working',
  starting: 'bg-working',
  rotating: 'bg-rotating',
  idle: 'bg-muted',
  asleep: 'border border-faint',  // hollow: no process
  stopped: 'border border-faint',
  error: 'bg-danger',
};
export const STATUS_LABEL: Record<AgentStatus, string> = {
  working: 'working', starting: 'starting', rotating: 'refreshing', idle: 'idle',
  asleep: 'asleep', stopped: 'stopped', error: 'error',
};

/** Why a context refresh happened (rotation reason from the node). */
export const REFRESH_REASON: Record<string, string> = {
  manual: 'refreshed by you', context: 'context was filling up', ceiling: 'session hit its token ceiling',
  velocity: 'context was growing fast', degraded: 'responses were degrading', requested: 'the agent asked for it',
};

export function StatusDot({ status, className }: { status: AgentStatus; className?: string }) {
  const live = status === 'working' || status === 'starting' || status === 'rotating';
  return <span className={cn('inline-block h-1.5 w-1.5 shrink-0 rounded-full', STATUS_COLOR[status], live && 'animate-pulse-dot', className)} />;
}

export function ConnDot({ status }: { status: ConnStatus }) {
  return (
    <span
      title={status}
      className={cn('inline-block h-1.5 w-1.5 shrink-0 rounded-full',
        status === 'online' ? 'bg-muted' : status === 'connecting' ? 'bg-warning animate-pulse-dot' : 'bg-danger')}
    />
  );
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Modal keyboard behaviour: focus moves inside on open (first [autofocus] or focusable),
 * Tab cycles within, Escape closes (captured, so it never reaches e.g. the composer's
 * interrupt), and focus returns to where it was on close.
 */
export function useModalFocus(ref: RefObject<HTMLElement | null>, open: boolean, onClose: () => void): void {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const raf = requestAnimationFrame(() => {
      const el = ref.current;
      // Focus the dialog itself (not its first button, which would show a focus ring); Tab moves in.
      if (el && !el.contains(document.activeElement)) (el.querySelector<HTMLElement>('[autofocus]') ?? el).focus();
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close.current(); return; }
      if (e.key !== 'Tab' || !ref.current) return;
      const items = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((n) => n.offsetParent !== null);
      if (items.length === 0) { e.preventDefault(); return; }
      const first = items[0], last = items[items.length - 1];
      const inside = ref.current.contains(document.activeElement);
      if (e.shiftKey && (document.activeElement === first || !inside)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !inside)) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKey, true);
      if (prev?.isConnected) prev.focus();
    };
  }, [open, ref]);
}

/** Close a popover on outside pointer-down or Escape. */
export function useDismiss(ref: RefObject<HTMLElement | null>, open: boolean, onClose: () => void): void {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) close.current(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close.current(); } };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => { window.removeEventListener('pointerdown', onDown, true); window.removeEventListener('keydown', onKey, true); };
  }, [open, ref]);
}

export function Modal({ open, onClose, title, children, width = 440 }: { open: boolean; onClose: () => void; title: string; children: ReactNode; width?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useModalFocus(ref, open, onClose);
  if (!open) return null;
  return (
    <div className="no-drag fixed inset-0 z-50 flex items-start justify-center bg-[var(--overlay)] pt-[12vh]" onMouseDown={onClose}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="animate-fade-in rounded-md border border-border bg-elevated shadow-pop outline-none"
        style={{ width, maxWidth: 'calc(100vw - 2rem)' }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex h-10 items-center justify-between border-b border-border-subtle pl-4 pr-2">
          <h2 id={titleId} className="label !text-secondary">{title}</h2>
          <IconButton title="Close" onClick={onClose}><X size={14} /></IconButton>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-border bg-control px-1 font-sans text-2xs text-muted">{children}</kbd>;
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="mb-3 block">
      <span className="mb-1 block text-xs font-medium text-muted">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-2xs text-faint">{hint}</span>}
    </label>
  );
}

export const inputCls =
  'w-full rounded border border-border bg-inset px-2.5 py-1.5 text-[13px] text-primary placeholder:text-faint outline-none transition-colors hover:border-control-hover focus:border-control-hover';

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
}
