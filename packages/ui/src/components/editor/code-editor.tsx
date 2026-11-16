import { useEffect, useRef, useState } from 'react';
import { Compartment, EditorState } from '@codemirror/state';
import {
  drawSelection, dropCursor, EditorView, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, keymap, lineNumbers, rectangularSelection,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { axoEditorTheme, axoHighlight } from './cm-theme.ts';

export interface Selection { from: number; to: number; fromLine: number; toLine: number; text: string }

/**
 * One CodeMirror instance per open file (keyed by path by the caller). `content` changes
 * from outside (disk reloads) are applied without losing the cursor when possible.
 */
export function CodeEditor({ path, content, onChange, onSave, onSelection, readOnly = false }: {
  path: string;
  content: string;
  onChange(content: string): void;
  onSave(): void;
  onSelection?(sel: Selection | null): void;
  readOnly?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const lastEmitted = useRef(content);
  const cbs = useRef({ onChange, onSave, onSelection });
  cbs.current = { onChange, onSave, onSelection };
  const [lang] = useState(() => new Compartment());

  useEffect(() => {
    const state = EditorState.create({
      doc: content,
      extensions: [
        lineNumbers(), highlightActiveLineGutter(), highlightSpecialChars(), history(), foldGutter(), drawSelection(), dropCursor(),
        EditorState.allowMultipleSelections.of(true), indentOnInput(), bracketMatching(), closeBrackets(), rectangularSelection(),
        highlightActiveLine(), highlightSelectionMatches(),
        keymap.of([
          { key: 'Mod-s', preventDefault: true, run: () => { cbs.current.onSave(); return true; } },
          ...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, indentWithTab,
        ]),
        axoEditorTheme, axoHighlight, lang.of([]),
        EditorState.readOnly.of(readOnly),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) {
            const text = u.state.doc.toString();
            lastEmitted.current = text;
            cbs.current.onChange(text);
          }
          if (u.selectionSet || u.docChanged) {
            const r = u.state.selection.main;
            if (r.empty) cbs.current.onSelection?.(null);
            else {
              const fromLine = u.state.doc.lineAt(r.from).number, toLine = u.state.doc.lineAt(r.to).number;
              cbs.current.onSelection?.({ from: r.from, to: r.to, fromLine, toLine, text: u.state.sliceDoc(r.from, r.to) });
            }
          }
        }),
      ],
    });
    const v = new EditorView({ state, parent: host.current! });
    view.current = v;
    v.focus();
    // Language support loads lazily per file type.
    const desc = LanguageDescription.matchFilename(languages, path.split('/').pop() ?? path);
    let live = true;
    void desc?.load().then((support) => { if (live) v.dispatch({ effects: lang.reconfigure(support) }); });
    return () => { live = false; v.destroy(); view.current = null; };
  }, [path]); // eslint-disable-line react-hooks/exhaustive-deps

  // Content replaced from outside (reload from disk / revert).
  useEffect(() => {
    const v = view.current;
    if (!v || content === lastEmitted.current) return;
    lastEmitted.current = content;
    const head = Math.min(v.state.selection.main.head, content.length);
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: content }, selection: { anchor: head } });
  }, [content]);

  return <div ref={host} className="h-full min-h-0 overflow-hidden" />;
}
