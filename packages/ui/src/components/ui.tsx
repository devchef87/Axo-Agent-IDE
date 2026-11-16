import { clsx } from 'clsx';
import { useEffect, type ButtonHTMLAttributes, type ReactNode } from 'react';
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
        'inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors disabled:opacity-40 disabled:pointer-events-none cursor-pointer',
        size === 'sm' ? 'h-6 px-2 text-xs' : 'h-8 px-3 text-[13px]',
        variant === 'primary' && 'bg-accent text-surface-0 hover:bg-accent/85',
        variant === 'subtle' && 'bg-surface-5 text-text-1 hover:bg-surface-6',
        variant === 'ghost' && 'text-text-2 hover:text-text-0 hover:bg-surface-5',
        variant === 'danger' && 'bg-danger/15 text-danger hover:bg-danger/25',
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
      className={cn('inline-flex h-6 w-6 items-center justify-center rounded text-text-3 hover:bg-surface-5 hover:text-text-0 transition-colors cursor-pointer disabled:opacity-40', className)}
    />
  );
}

const STATUS_COLOR: Record<AgentStatus, string> = {
  working: 'bg-accent',
  starting: 'bg-accent',
  rotating: 'bg-purple',
  idle: 'bg-success',
  asleep: 'bg-text-4',
  stopped: 'bg-text-4',
  error: 'bg-danger',
};
export const STATUS_LABEL: Record<AgentStatus, string> = {
  working: 'working', starting: 'starting', rotating: 'refreshing', idle: 'idle',
  asleep: 'asleep', stopped: 'stopped', error: 'error',
};

export function StatusDot({ status, className }: { status: AgentStatus; className?: string }) {
  const live = status === 'working' || status === 'starting' || status === 'rotating';
  return <span className={cn('inline-block h-2 w-2 shrink-0 rounded-full', STATUS_COLOR[status], live && 'animate-pulse-dot', className)} />;
}

export function ConnDot({ status }: { status: ConnStatus }) {
  return (
    <span
      title={status}
      className={cn('inline-block h-1.5 w-1.5 shrink-0 rounded-full',
        status === 'online' ? 'bg-success' : status === 'connecting' ? 'bg-warning animate-pulse-dot' : 'bg-danger')}
    />
  );
}

export function Modal({ open, onClose, title, children, width = 440 }: { open: boolean; onClose: () => void; title: string; children: ReactNode; width?: number }) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="no-drag fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[12vh]" onMouseDown={onClose}>
      <div
        className="animate-fade-in rounded-lg border border-border bg-surface-3 shadow-2xl"
        style={{ width }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border-subtle px-4 py-2.5">
          <h2 className="text-[13px] font-semibold text-text-0">{title}</h2>
          <IconButton title="Close" onClick={onClose}><X size={14} /></IconButton>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="mb-3 block">
      <span className="mb-1 block text-xs font-medium text-text-2">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-2xs text-text-3">{hint}</span>}
    </label>
  );
}

export const inputCls =
  'w-full rounded-md border border-border bg-surface-1 px-2.5 py-1.5 text-[13px] text-text-0 placeholder:text-text-4 outline-none focus:border-accent/70';

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
