// Theme preference (System / Light / Dark). Applied as data-theme on <html>; app.css
// holds the tokens. In Electron we also tell the main process so the native window
// background, traffic lights and native dialogs match.
import { create } from 'zustand';
import { bridge } from './bridge.ts';

export type ThemePref = 'system' | 'light' | 'dark';
export type Theme = 'light' | 'dark';

const KEY = 'axo.theme';
const media = window.matchMedia('(prefers-color-scheme: dark)');

function readPref(): ThemePref {
  const v = localStorage.getItem(KEY);
  return v === 'light' || v === 'dark' ? v : 'system';
}

const resolve = (pref: ThemePref): Theme => (pref === 'system' ? (media.matches ? 'dark' : 'light') : pref);

function apply(pref: ThemePref, theme: Theme): void {
  const root = document.documentElement;
  root.dataset.theme = theme;
  const bg = getComputedStyle(root).getPropertyValue('--bg').trim();
  bridge?.setTheme?.(pref, bg);
}

interface ThemeState {
  pref: ThemePref;
  theme: Theme;
  setPref(pref: ThemePref): void;
  cycle(): void;
}

export const useTheme = create<ThemeState>((set, get) => ({
  pref: readPref(),
  theme: resolve(readPref()),
  setPref(pref) {
    if (pref === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, pref);
    const theme = resolve(pref);
    set({ pref, theme });
    apply(pref, theme);
  },
  cycle() {
    const order: ThemePref[] = ['system', 'light', 'dark'];
    get().setPref(order[(order.indexOf(get().pref) + 1) % order.length]);
  },
}));

/** Call once before first render to avoid a flash of the wrong theme. */
export function initTheme(): void {
  const { pref, theme } = useTheme.getState();
  apply(pref, theme);
  // Follows the OS live. In Electron, switching back to System also flips nativeTheme,
  // which fires this once the main process catches up.
  media.addEventListener('change', () => {
    const s = useTheme.getState();
    if (s.pref !== 'system') return;
    const theme = resolve('system');
    useTheme.setState({ theme });
    apply('system', theme);
  });
  // Another window/tab changed the preference.
  window.addEventListener('storage', (e) => { if (e.key === KEY) useTheme.getState().setPref(readPref()); });
}
