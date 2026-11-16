import type { ITheme } from '@xterm/xterm';
import type { Theme } from './theme.ts';

// Shell programs need the 16 ANSI colours, so the terminal is one of the few places with real colour.
// Muted to sit with the monochrome UI; background, text and cursor come from the app tokens.
const ANSI: Record<Theme, Partial<ITheme>> = {
  dark: {
    black: '#1c1c1f', red: '#ef6f62', green: '#7fbf8e', yellow: '#d9b45a', blue: '#7ea6d8', magenta: '#c49ad6', cyan: '#7cc4c0', white: '#d4d4d8',
    brightBlack: '#71717a', brightRed: '#f58a7f', brightGreen: '#98d4a6', brightYellow: '#e6c777', brightBlue: '#9bbde6', brightMagenta: '#d5b2e3', brightCyan: '#99d6d2', brightWhite: '#fafafa',
  },
  light: {
    black: '#0a0a0a', red: '#c0392b', green: '#2e7d4f', yellow: '#946200', blue: '#2f5f9e', magenta: '#8a3fa0', cyan: '#1f7a74', white: '#a1a1aa',
    brightBlack: '#555555', brightRed: '#d9473a', brightGreen: '#3a9461', brightYellow: '#a87000', brightBlue: '#3d72b8', brightMagenta: '#a04fb8', brightCyan: '#278f88', brightWhite: '#d4d4d8',
  },
};

export function terminalTheme(theme: Theme): ITheme {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return {
    ...ANSI[theme],
    background: v('--terminal'),
    foreground: v('--text-primary'),
    cursor: v('--accent'),
    cursorAccent: v('--terminal'),
    selectionBackground: theme === 'dark' ? 'rgba(250,250,250,0.22)' : 'rgba(10,10,10,0.16)',
    scrollbarSliderBackground: v('--scrollbar'),
    scrollbarSliderHoverBackground: v('--scrollbar-hover'),
    scrollbarSliderActiveBackground: v('--scrollbar-hover'),
  };
}

export const terminalFont = () => getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim() || 'monospace';
