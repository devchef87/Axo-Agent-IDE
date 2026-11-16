import { useEffect, useRef, useState } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView, lineNumbers } from '@codemirror/view';
import { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { MergeView } from '@codemirror/merge';
import { FileText } from 'lucide-react';
import type { FileContent, OriginalRes } from '@axo/protocol';
import type { EditorTarget } from '../../lib/editor-model.ts';
import { fileQuery, useEditor } from '../../stores/editor.ts';
import { useAxo } from '../../stores/store.ts';
import { Button } from '../ui.tsx';
import { axoEditorTheme, axoHighlight } from './cm-theme.ts';
import { Centered } from './media-viewer.tsx';

/** Side-by-side: HEAD on the left, the working copy on the right. Refetches on `rev`. */
export function DiffView({ target, path }: { target: EditorTarget; path: string }) {
  const client = useAxo((s) => s.client);
  const rev = useEditor((s) => s.rev);
  const open = useEditor((s) => s.open);
  const host = useRef<HTMLDivElement>(null);
  const [data, setData] = useState<{ before: string; after: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const c = client(target.nodeKey);
    const base = `/projects/${target.projectId}/files`;
    Promise.all([
      c.get<OriginalRes>(`${base}/original${fileQuery(target, { path })}`),
      c.get<FileContent>(`${base}/read${fileQuery(target, { path })}`).catch(() => null),
    ]).then(([o, cur]) => {
      if (!live) return;
      if (cur && cur.content === null) { setError(cur.binary ? 'Binary file; no text diff.' : 'File too large to diff.'); return; }
      setError(null);
      setData({ before: o.content ?? '', after: cur?.content ?? '' });
    }, (e: Error) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [client, target, path, rev]);

  useEffect(() => {
    if (!data || data.before === data.after) return;
    let mv: MergeView | null = null;
    let live = true;
    const desc = LanguageDescription.matchFilename(languages, path.split('/').pop() ?? path);
    // Load highlighting first so the merge view is built once.
    void (desc ? desc.load().catch(() => null) : Promise.resolve(null)).then((support) => {
      if (!live || !host.current) return;
      const ext = [lineNumbers(), axoEditorTheme, axoHighlight, EditorState.readOnly.of(true), EditorView.editable.of(false), ...(support ? [support] : [])];
      mv = new MergeView({
        a: { doc: data.before, extensions: ext },
        b: { doc: data.after, extensions: ext },
        parent: host.current,
        collapseUnchanged: { margin: 3, minSize: 6 },
        gutter: true,
      });
    });
    return () => { live = false; mv?.destroy(); };
  }, [data, path]);

  if (error) return <Centered>{error}</Centered>;
  if (!data) return <Centered>Loading diff…</Centered>;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border-subtle px-3 text-2xs text-faint">
        <span className="flex-1 text-center">HEAD</span>
        <span className="flex-1 text-center">Working copy</span>
        <Button size="sm" variant="ghost" onClick={() => open({ kind: 'file', path })}><FileText size={11} /> Open file</Button>
      </div>
      {data.before === data.after
        ? <Centered>No changes against HEAD.</Centered>
        : <div ref={host} className="diff-host min-h-0 flex-1 overflow-auto" />}
    </div>
  );
}
