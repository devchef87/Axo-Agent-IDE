// CodeMirror theme built on the app's CSS variables, so it follows light/dark live
// without reconfiguring the editor. Syntax colours come from --syn-* (AA-checked).
import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

const sel = 'color-mix(in oklab, var(--accent) 24%, transparent)';

export const axoEditorTheme = EditorView.theme({
  '&': { color: 'var(--text-primary)', backgroundColor: 'var(--bg)', height: '100%', fontSize: '12.5px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.6' },
  '.cm-content': { caretColor: 'var(--accent)', padding: '6px 0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': { backgroundColor: sel },
  '.cm-gutters': { backgroundColor: 'var(--bg)', color: 'var(--text-faint)', border: 'none', paddingLeft: '4px' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 10px 0 6px', minWidth: '32px' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in oklab, var(--hover) 55%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--text-secondary)' },
  '.cm-foldGutter .cm-gutterElement': { color: 'var(--text-faint)' },
  '.cm-foldPlaceholder': { backgroundColor: 'var(--control)', border: 'none', color: 'var(--text-muted)', padding: '0 4px' },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': { backgroundColor: 'var(--control)', outline: '1px solid var(--border-strong)' },
  '.cm-searchMatch': { backgroundColor: 'color-mix(in oklab, var(--accent) 16%, transparent)', outline: '1px solid color-mix(in oklab, var(--accent) 40%, transparent)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'color-mix(in oklab, var(--accent) 32%, transparent)' },
  '.cm-selectionMatch': { backgroundColor: 'color-mix(in oklab, var(--info) 18%, transparent)' },
  '.cm-panels': { backgroundColor: 'var(--panel)', color: 'var(--text-secondary)', borderColor: 'var(--border-subtle)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--border-subtle)' },
  '.cm-panel input, .cm-panel button, .cm-textfield': {
    backgroundColor: 'var(--bg)', color: 'var(--text-primary)', border: '1px solid var(--border-strong)', borderRadius: '2px', fontSize: '12px',
  },
  '.cm-button': { backgroundImage: 'none', backgroundColor: 'var(--control)', color: 'var(--text-secondary)', border: 'none', borderRadius: '2px' },
  '.cm-panel.cm-search label': { color: 'var(--text-muted)', fontSize: '12px' },
  '.cm-tooltip': { backgroundColor: 'var(--elevated)', color: 'var(--text-secondary)', border: '1px solid var(--border)', borderRadius: '3px' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--control)', color: 'var(--text-primary)' },
  // merge view
  '.cm-changedLine': { backgroundColor: 'color-mix(in oklab, var(--success) 9%, transparent)' },
  '.cm-deletedChunk': { backgroundColor: 'color-mix(in oklab, var(--danger) 9%, transparent)' },
  '.cm-changedText': { background: 'color-mix(in oklab, var(--success) 28%, transparent)' },
  '.cm-deletedText, .cm-deletedChunk .cm-deletedText': { background: 'color-mix(in oklab, var(--danger) 28%, transparent)' },
  '.cm-merge-a .cm-changedLine': { backgroundColor: 'color-mix(in oklab, var(--danger) 9%, transparent)' },
  '.cm-merge-a .cm-changedText': { background: 'color-mix(in oklab, var(--danger) 28%, transparent)' },
  '.cm-collapsedLines': { backgroundColor: 'var(--panel)', color: 'var(--text-muted)', backgroundImage: 'none' },
});

export const axoHighlight = syntaxHighlighting(HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword, t.modifier], color: 'var(--syn-keyword)' },
  { tag: [t.string, t.special(t.string), t.regexp, t.character], color: 'var(--syn-string)' },
  { tag: [t.number, t.bool, t.null, t.atom, t.unit], color: 'var(--syn-number)' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: 'var(--syn-function)' },
  { tag: [t.typeName, t.className, t.namespace, t.definition(t.typeName)], color: 'var(--syn-type)' },
  { tag: [t.propertyName, t.attributeName, t.labelName], color: 'var(--syn-property)' },
  { tag: [t.tagName, t.angleBracket], color: 'var(--syn-tag)' },
  { tag: [t.heading], color: 'var(--text-primary)', fontWeight: '600' },
  { tag: [t.emphasis], fontStyle: 'italic' },
  { tag: [t.strong], fontWeight: '600' },
  { tag: [t.link, t.url], color: 'var(--accent)', textDecoration: 'underline' },
  { tag: [t.invalid], color: 'var(--danger)' },
  { tag: [t.meta, t.processingInstruction], color: 'var(--text-muted)' },
]));
