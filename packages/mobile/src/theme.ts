import { StyleSheet } from 'react-native';

// Axo dark theme: the desktop's tokens exactly (packages/ui/src/app.css, [data-theme="dark"]).
// One cool blue-grey family, white text, one indigo accent. Every text/surface pair passes WCAG AA.
export const C = {
  bg: '#1F2126',            // chat body
  panel: '#24282F',         // header bar, drawer
  inset: '#2A2E36',         // composer, code blocks, tool output
  elevated: '#292d35',      // menus, sheets
  control: '#343944',       // your bubble, buttons, badges
  controlHover: '#3d4350',  // pressed buttons; composer focus border
  hover: '#2e333b',         // pressed rows
  border: '#323743',
  borderSubtle: '#2a2e36',
  borderStrong: '#7d8186',  // other-agent rule, focus ring (never accent)
  primary: '#ffffff',       // names, headings, bold
  secondary: '#e3e3e3',     // normal UI text
  body: '#c4c7c5',          // long-form reply text: softer than white to cut glare
  muted: '#c4c7c5',
  faint: '#a8abae',
  dim: '#8e9196',           // roles, counts, timestamps
  dotSoft: '#3d424b',       // asleep agents, servers you're not in
  accent: '#5446FA',        // fills only: Send, reply rule (never as text: 2.8:1)
  accentHover: '#4636e8',
  accentFg: '#ffffff',
  accentText: '#8a80ff',    // indigo as small text (selected agent)
  working: '#7c72ff',       // status dots, spinners
  success: '#81c995',
  warning: '#fdd663',
  danger: '#f28b82',
  overlay: 'rgba(0,0,0,0.6)',
} as const;

/** Bundled Google Sans static weights (no synthesized bold). See components/text.tsx. */
export const FONT = { regular: 'GoogleSans-Regular', medium: 'GoogleSans-Medium', bold: 'GoogleSans-Bold' } as const;
export const mono = 'monospace';

/** Crisp 1-physical-pixel lines for dividers and rules. */
export const HAIR = StyleSheet.hairlineWidth;

/**
 * Phone type scale. Desktop's reply body is 14.5px at arm's length; on a phone 16 reads the same.
 * Ratios kept: line height 1.7×, headings 1.35 / 1.2 / 1.08×.
 */
export const TYPE = {
  body: 16,
  bodyLine: 27,
  bubble: 15.5,
} as const;
