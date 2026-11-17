import { memo, useMemo, type ReactNode } from 'react';
import { Linking, ScrollView, Text, View, type TextStyle } from 'react-native';
import { marked, type Token, type Tokens } from 'marked';
import { C, mono } from '../theme.ts';

// A small Markdown renderer over marked's lexer: no WebView, no native module, works in Expo Go.
// Covers what agents write: paragraphs, headings, lists (nested, tasks), code, quotes, tables, links.

const BASE: TextStyle = { color: C.secondary, fontSize: 15, lineHeight: 22 };
const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };
const decode = (s: string) => s.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m] ?? m);

export const Markdown = memo(function Markdown({ text, color }: { text: string; color?: string }) {
  const tokens = useMemo(() => {
    try { return marked.lexer(text, { gfm: true }); } catch { return null; }
  }, [text]);
  if (!tokens) return <Text style={[BASE, color ? { color } : null]}>{text}</Text>;
  return <View>{blocks(tokens, color ? { ...BASE, color } : BASE, 'r')}</View>;
});

function blocks(tokens: Token[], base: TextStyle, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  let inline: Token[] = [];
  const flush = () => {
    if (!inline.length) return;
    const k = `${key}-i${out.length}`;
    out.push(<Text key={k} style={base}>{inlines(inline, base, k)}</Text>);
    inline = [];
  };
  tokens.forEach((t, i) => {
    const k = `${key}-${i}`;
    switch (t.type) {
      case 'space': flush(); break;
      case 'paragraph':
        flush();
        out.push(<Text key={k} style={[base, { marginVertical: 5 }]}>{inlines((t as Tokens.Paragraph).tokens, base, k)}</Text>);
        break;
      case 'heading': {
        flush();
        const h = t as Tokens.Heading;
        const size = h.depth === 1 ? 19 : h.depth === 2 ? 17 : 15.5;
        const style = { ...base, fontSize: size, lineHeight: size * 1.35, fontWeight: '600' as const, color: C.primary };
        out.push(<Text key={k} style={[style, { marginTop: 12, marginBottom: 4 }]}>{inlines(h.tokens, style, k)}</Text>);
        break;
      }
      case 'code': {
        flush();
        const c = t as Tokens.Code;
        out.push(
          <ScrollView key={k} horizontal style={{ marginVertical: 6, borderRadius: 6, backgroundColor: C.inset, borderWidth: 1, borderColor: C.borderSubtle }}
            contentContainerStyle={{ padding: 10 }} showsHorizontalScrollIndicator={false}>
            <Text style={{ fontFamily: mono, fontSize: 12.5, lineHeight: 18, color: C.muted }}>{c.text}</Text>
          </ScrollView>,
        );
        break;
      }
      case 'blockquote':
        flush();
        out.push(
          <View key={k} style={{ borderLeftWidth: 2, borderLeftColor: C.borderStrong, paddingLeft: 10, marginVertical: 4 }}>
            {blocks((t as Tokens.Blockquote).tokens, { ...base, color: C.muted }, k)}
          </View>,
        );
        break;
      case 'list': {
        flush();
        const l = t as Tokens.List;
        const start = typeof l.start === 'number' ? l.start : 1;
        out.push(
          <View key={k} style={{ marginVertical: 4 }}>
            {l.items.map((item, n) => {
              const bullet = item.task ? (item.checked ? '☑' : '☐') : l.ordered ? `${start + n}.` : '•';
              return (
                <View key={n} style={{ flexDirection: 'row', marginVertical: 1 }}>
                  <Text style={[base, { width: l.ordered ? 24 : 16, color: C.dim }]}>{bullet}</Text>
                  <View style={{ flex: 1 }}>{blocks(item.tokens.filter((x) => x.type !== 'checkbox'), base, `${k}-${n}`)}</View>
                </View>
              );
            })}
          </View>,
        );
        break;
      }
      case 'hr':
        flush();
        out.push(<View key={k} style={{ height: 1, backgroundColor: C.border, marginVertical: 10 }} />);
        break;
      case 'table': {
        flush();
        const tb = t as Tokens.Table;
        const cell = (c: Tokens.TableCell, n: number, head: boolean) => (
          <View key={n} style={{ minWidth: 80, maxWidth: 220, paddingHorizontal: 8, paddingVertical: 5, borderRightWidth: 1, borderColor: C.borderSubtle }}>
            <Text style={[base, { fontSize: 13.5, lineHeight: 19 }, head && { fontWeight: '600', color: C.primary }]}>{inlines(c.tokens, base, `${k}-c${n}`)}</Text>
          </View>
        );
        out.push(
          <ScrollView key={k} horizontal style={{ marginVertical: 6 }} showsHorizontalScrollIndicator={false}>
            <View style={{ borderWidth: 1, borderColor: C.borderSubtle, borderRadius: 4 }}>
              <View style={{ flexDirection: 'row', backgroundColor: C.inset }}>{tb.header.map((c, n) => cell(c, n, true))}</View>
              {tb.rows.map((r, ri) => (
                <View key={ri} style={{ flexDirection: 'row', borderTopWidth: 1, borderColor: C.borderSubtle }}>{r.map((c, n) => cell(c, n, false))}</View>
              ))}
            </View>
          </ScrollView>,
        );
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
        out.push(<Text key={k} style={[base, { color: C.muted }]}>{(t as Tokens.HTML).text.trim()}</Text>);
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
      case 'em': return <Text key={k} style={{ fontStyle: 'italic' }}>{inlines((t as Tokens.Em).tokens, base, k)}</Text>;
      case 'del': return <Text key={k} style={{ textDecorationLine: 'line-through' }}>{inlines((t as Tokens.Del).tokens, base, k)}</Text>;
      case 'codespan':
        return <Text key={k} style={{ fontFamily: mono, fontSize: (base.fontSize ?? 15) - 1.5, color: C.primary, backgroundColor: C.inset }}>{` ${decode((t as Tokens.Codespan).text)} `}</Text>;
      case 'link': {
        const l = t as Tokens.Link;
        return <Text key={k} style={{ color: C.accent }} onPress={() => void Linking.openURL(l.href).catch(() => {})}>{inlines(l.tokens, base, k)}</Text>;
      }
      case 'image': return <Text key={k} style={{ color: C.dim }}>[{(t as Tokens.Image).text || 'image'}]</Text>;
      case 'br': return '\n';
      case 'text': {
        const tt = t as Tokens.Text;
        return tt.tokens ? <Text key={k}>{inlines(tt.tokens, base, k)}</Text> : decode(tt.text);
      }
      case 'escape': return (t as Tokens.Escape).text;
      case 'html': return (t as Tokens.HTML).text;
      default: return 'text' in t && typeof t.text === 'string' ? decode(t.text) : '';
    }
  });
}
