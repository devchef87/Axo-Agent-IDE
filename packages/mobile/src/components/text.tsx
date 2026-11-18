import { createContext, useContext } from 'react';
import { StyleSheet, Text as RNText, TextInput as RNTextInput, type TextInputProps, type TextProps, type TextStyle } from 'react-native';
import { FONT, mono } from '../theme.ts';

/**
 * Text in Google Sans. `fontWeight` picks the bundled static file (400 / 500 / 600–700) and is then dropped,
 * so Android never synthesises bold. Nested text without a weight inherits its parent's face; monospace is left alone.
 */
const InText = createContext(false);

function familyFor(w: TextStyle['fontWeight']): string | null {
  const v = String(w ?? '');
  if (v === '700' || v === '600' || v === '800' || v === '900' || v === 'bold') return FONT.bold;
  if (v === '500') return FONT.medium;
  if (v === '400' || v === 'normal' || v === '300') return FONT.regular;
  return null;
}

function withFont(style: TextProps['style'], nested: boolean): TextStyle {
  const s = (StyleSheet.flatten(style) ?? {}) as TextStyle;
  if (s.fontFamily === mono) return s;
  const { fontWeight, ...rest } = s;
  const family = familyFor(fontWeight) ?? s.fontFamily ?? (nested ? undefined : FONT.regular);
  // Google Sans has tall metrics; Android's extra font padding on top of them pushes text off-centre and clips inputs.
  const base: TextStyle = nested ? rest : { includeFontPadding: false, ...rest };
  return family ? { ...base, fontFamily: family } : base;
}

export function Text({ style, ...rest }: TextProps) {
  const nested = useContext(InText);
  const t = <RNText {...rest} style={withFont(style, nested)} />;
  return nested ? t : <InText.Provider value>{t}</InText.Provider>;
}

export function TextInput({ style, ...rest }: TextInputProps) {
  return <RNTextInput {...rest} style={withFont(style, false)} />;
}
