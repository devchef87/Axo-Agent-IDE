import { memo, useMemo, type ReactNode } from 'react';
import { Linking, ScrollView, View, type TextStyle } from 'react-native';
import { Text } from './text.tsx';
import { marked, type Token, type Tokens } from 'marked';
import { C, HAIR, mono, TYPE } from '../theme.ts';

// A small Markdown renderer over marked's lexer: no WebView, no native module.
// Styled to the desktop's .md rules (packages/ui/src/app.css), scaled from 14.5px to a 16pt phone body:
// weight 500, line height 1.7, 0.01em tracking, #c4c7c5 body; white bold headings; paragraph gap 0.75em.

const SIZE = TYPE.body;
const em = (n: number) => Math.round(n * SIZE * 10) / 10;
const BASE: TextStyle = { color: C.body, fontSize: SIZE, lineHeight: TYPE.bodyLine, fontWeight: '500', letterSpacing: SIZE * 0.01 };
const HEADING: Record<number, number> = { 1: 1.35, 2: 1.2, 3: 1.08 };
const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };
const decode = (s: string) => s.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m] ?? m);

export const Markdown = memo(function Markdown({ text, color }: { text: string; color?: string }) {
  const tokens = useMemo(() => {
    try { return marked.lexer(text, { gfm: true }); } catch { return null; }
  }, [text]);
  const base = color ? { ...BASE, color } : BASE;
  if (!tokens) return <Text style={base}>{text}</Text>;
  return <View>{blocks(tokens, base, 'r')}</View>;
});

/** Space above a block, given what came before it (desktop margins collapse the same way). */
function gapBefore(type: string, prev: string | null, tight = false): number {
  if (prev === null) return 0;
  if (type === 'heading') return em(1.5);
  if (prev === 'heading') return em(0.5);
  if (tight) return em(0.4);
  if (type === 'code' || type === 'table' || prev === 'code' || prev === 'table') return em(0.9);
  if (type === 'hr' || prev === 'hr') return em(1);
  return em(0.75);
}

function blocks(tokens: Token[], base: TextStyle, key: string, tight = false): ReactNode[] {
  const out: ReactNode[] = [];
  let prev: string | null = null;
  let inline: Token[] = [];
  const push = (type: string, node: (mt: number) => ReactNode) => {
    out.push(node(gapBefore(type, prev, tight)));
    prev = type;
  };
  const flush = () => {
    if (!inline.length) return;
    const k = `${key}-i${out.length}`;
    const toks = inline;
    inline = [];
    push('paragraph', (mt) => <Text key={k} style={[base, { marginTop: mt }]}>{inlines(toks, base, k)}</Text>);
  };
  tokens.forEach((t, i) => {
    const k = `${key}-${i}`;
    switch (t.type) {
      case 'space': flush(); break;
      case 'paragraph':
        flush();
        push('paragraph', (mt) => <Text key={k} style={[base, { marginTop: mt }]}>{inlines((t as Tokens.Paragraph).tokens, base, k)}</Text>);
        break;
      case 'heading': {
        flush();
        const h = t as Tokens.Heading;
        const size = em(HEADING[h.depth] ?? 1);
        const style: TextStyle = { ...base, fontSize: size, lineHeight: Math.round(size * 1.3), fontWeight: '700', color: C.primary, letterSpacing: -size * 0.005 };
        push('heading', (mt) => <Text key={k} style={[style, { marginTop: mt }]}>{inlines(h.tokens, style, k)}</Text>);
        break;
      }
      case 'code': {
        flush();
        const c = t as Tokens.Code;
        push('code', (mt) => (
          <ScrollView key={k} horizontal showsHorizontalScrollIndicator={false}
            style={{ marginTop: mt, borderRadius: 3, backgroundColor: C.inset, borderWidth: HAIR, borderColor: C.border }}
            contentContainerStyle={{ paddingHorizontal: em(0.9), paddingVertical: em(0.7) }}>
            <Text style={{ fontFamily: mono, fontSize: em(0.82), lineHeight: Math.round(em(0.82) * 1.5), color: C.primary }}>{c.text}</Text>
          </ScrollView>
        ));
        break;
      }
      case 'blockquote':
        flush();
        push('blockquote', (mt) => (
          <View key={k} style={{ marginTop: mt, borderLeftWidth: 2, borderLeftColor: C.border, paddingLeft: em(0.8) }}>
            {blocks((t as Tokens.Blockquote).tokens, base, k)}
          </View>
        ));
        break;
      case 'list': {
        flush();
        const l = t as Tokens.List;
        const start = typeof l.start === 'number' ? l.start : 1;
        push('list', (mt) => (
          <View key={k} style={{ marginTop: mt }}>
            {l.items.map((item, n) => {
              const bullet = item.task ? (item.checked ? '☑' : '☐') : l.ordered ? `${start + n}.` : '•';
              return (
                <View key={n} style={{ flexDirection: 'row', marginTop: n === 0 ? 0 : em(0.4) }}>
                  <Text style={[base, { width: em(l.ordered ? 1.6 : 1.2), color: C.dim, textAlign: l.ordered ? 'right' : 'center', marginRight: em(0.35) }]}>{bullet}</Text>
                  <View style={{ flex: 1 }}>{blocks(item.tokens.filter((x) => x.type !== 'checkbox'), base, `${k}-${n}`, true)}</View>
                </View>
              );
            })}
          </View>
        ));
        break;
      }
      case 'hr':
        flush();
        push('hr', (mt) => <View key={k} style={{ marginTop: mt, height: HAIR, backgroundColor: C.border }} />);
        break;
      case 'table': {
        flush();
        const tb = t as Tokens.Table;
        const fs = em(0.92);
        const cell = (c: Tokens.TableCell, n: number, head: boolean) => (
          <View key={n} style={{ minWidth: 84, maxWidth: 240, paddingHorizontal: em(0.6), paddingVertical: em(0.3), borderRightWidth: HAIR, borderColor: C.border }}>
            <Text style={[base, { fontSize: fs, lineHeight: Math.round(fs * 1.5) }, head && { fontWeight: '700', color: C.primary }]}>{inlines(c.tokens, base, `${k}-c${n}`)}</Text>
          </View>
        );
        push('table', (mt) => (
          <ScrollView key={k} horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: mt }}>
            <View style={{ borderWidth: HAIR, borderRightWidth: 0, borderColor: C.border }}>
              <View style={{ flexDirection: 'row', backgroundColor: C.panel }}>{tb.header.map((c, n) => cell(c, n, true))}</View>
              {tb.rows.map((r, ri) => (
                <View key={ri} style={{ flexDirection: 'row', borderTopWidth: HAIR, borderColor: C.border }}>{r.map((c, n) => cell(c, n, false))}</View>
              ))}
            </View>
          </ScrollView>
        ));
        break;
      }
      case 'text': {
        // Block-level text (tight list items): render its inline tokens with neighbours.
        const tt = t as Tokens.Text;
        if (tt.tokens) inline.push(...tt.tokens); else inline.push(t);
        break;
      }
      case 'html':
        flush();
        push('paragraph', (mt) => <Text key={k} style={[base, { marginTop: mt, color: C.faint }]}>{(t as Tokens.HTML).text.trim()}</Text>);
        break;
      default:
        inline.push(t);
    }
  });
  flush();
  return out;
}

function inlines(tokens: Token[] | undefined, base: TextStyle, key: string): ReactNode[] {
  if (!tokens) return [];
  return tokens.map((t, i) => {
    const k = `${key}-${i}`;
    switch (t.type) {
      case 'strong': return <Text key={k} style={{ fontWeight: '700', color: C.primary }}>{inlines((t as Tokens.Strong).tokens, base, k)}</Text>;
      case 'em': return <Text key={k} style={{ fontStyle: 'italic', fontWeight: base.fontWeight }}>{inlines((t as Tokens.Em).tokens, base, k)}</Text>;
      case 'del': return <Text key={k} style={{ textDecorationLine: 'line-through', fontWeight: base.fontWeight }}>{inlines((t as Tokens.Del).tokens, base, k)}</Text>;
      case 'codespan':
        return <Text key={k} style={{ fontFamily: mono, fontSize: Math.round((base.fontSize ?? SIZE) * 0.84 * 10) / 10, color: C.primary, backgroundColor: C.control, letterSpacing: 0 }}>{` ${decode((t as Tokens.Codespan).text)} `}</Text>;
      case 'link': {
        const l = t as Tokens.Link;
        return (
          <Text key={k} style={{ color: C.primary, fontWeight: base.fontWeight, textDecorationLine: 'underline', textDecorationColor: 'rgba(255,255,255,0.4)' }}
            onPress={() => void Linking.openURL(l.href).catch(() => {})}>{inlines(l.tokens, base, k)}</Text>
        );
      }
      case 'image': return <Text key={k} style={{ color: C.dim, fontWeight: base.fontWeight }}>[{(t as Tokens.Image).text || 'image'}]</Text>;
      case 'br': return '\n';
      case 'text': {
        const tt = t as Tokens.Text;
        return tt.tokens ? <Text key={k} style={{ fontWeight: base.fontWeight }}>{inlines(tt.tokens, base, k)}</Text> : decode(tt.text);
      }
      case 'escape': return (t as Tokens.Escape).text;
      case 'html': return (t as Tokens.HTML).text;
      default: return 'text' in t && typeof t.text === 'string' ? decode(t.text) : '';
    }
  });
}
