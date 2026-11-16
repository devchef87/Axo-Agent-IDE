import { lazy, Suspense, useState } from 'react';
import { Maximize2, Minimize2 } from 'lucide-react';
import type { FileKind } from '../../lib/editor-model.ts';
import { cn, IconButton } from '../ui.tsx';

const PdfViewer = lazy(() => import('./pdf-viewer.tsx'));

/** Images, video, audio and PDF, streamed from the node's raw endpoint. */
export function MediaViewer({ kind, url, name }: { kind: Exclude<FileKind, 'text'>; url: string; name: string }) {
  const [actual, setActual] = useState(false);
  const [error, setError] = useState(false);

  if (kind === 'pdf') {
    return (
      <Suspense fallback={<Centered>Loading PDF viewer…</Centered>}>
        <PdfViewer url={url} />
      </Suspense>
    );
  }
  if (error) return <Centered>Couldn't load {name}.</Centered>;

  if (kind === 'image') {
    return (
      <div className="relative flex h-full min-h-0 flex-col">
        <div className="absolute right-3 top-3 z-10 rounded-md border border-border bg-elevated shadow-pop">
          <IconButton title={actual ? 'Fit to view' : 'Actual size'} onClick={() => setActual(!actual)}>
            {actual ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
          </IconButton>
        </div>
        <div className={cn('checkerboard min-h-0 flex-1 overflow-auto', !actual && 'flex items-center justify-center p-6')}>
          <img
            src={url}
            alt={name}
            onError={() => setError(true)}
            className={cn(actual ? 'max-w-none' : 'max-h-full max-w-full object-contain', 'shadow-pop')}
          />
        </div>
      </div>
    );
  }
  if (kind === 'video') {
    return (
      <div className="flex h-full items-center justify-center bg-inset p-6">
        <video src={url} controls preload="metadata" onError={() => setError(true)} className="max-h-full max-w-full rounded-md shadow-pop" />
      </div>
    );
  }
  return (
    <Centered>
      <div className="flex flex-col items-center gap-3">
        <span className="text-secondary">{name}</span>
        <audio src={url} controls preload="metadata" onError={() => setError(true)} />
      </div>
    </Centered>
  );
}

export function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full items-center justify-center p-6 text-center text-xs text-faint">{children}</div>;
}
