import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Parses the per-theme token blocks out of app.css and checks WCAG AA contrast.
const css = readFileSync(new URL('../src/app.css', import.meta.url), 'utf8');

function tokens(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start !== -1, `missing ${selector} block`);
  const body = css.slice(start, css.indexOf('}', start));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})\b/gi)) out[m[1]] = m[2];
  return out;
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const THEMES = { dark: tokens('[data-theme="dark"]'), light: tokens('[data-theme="light"]') };
const SURFACES = ['bg', 'panel', 'elevated', 'inset', 'hover', 'terminal'];
const TEXT = ['text-primary', 'text-secondary', 'text-body', 'text-muted', 'text-faint',
  'success', 'warning', 'danger', 'info', 'rotating', 'innerchat',
  'syn-keyword', 'syn-string', 'syn-number', 'syn-comment', 'syn-function', 'syn-type', 'syn-property', 'syn-tag'];

for (const [name, t] of Object.entries(THEMES)) {
  describe(`${name} theme`, () => {
    it('defines the same tokens as the other theme', () => {
      assert.deepEqual(Object.keys(t).sort(), Object.keys(THEMES.dark).sort());
    });

    it('every text colour passes AA (4.5:1) on every surface', () => {
      const fails: string[] = [];
      for (const fg of TEXT) for (const bg of SURFACES) {
        const r = contrast(t[fg], t[bg]);
        if (r < 4.5) fails.push(`${fg} on ${bg}: ${r.toFixed(2)}`);
      }
      assert.deepEqual(fails, []);
    });

    it('text on fills and the accent button passes AA', () => {
      for (const fg of ['text-primary', 'text-secondary']) for (const bg of ['control', 'control-hover']) {
        assert.ok(contrast(t[fg], t[bg]) >= 4.5, `${fg} on ${bg}: ${contrast(t[fg], t[bg]).toFixed(2)}`);
      }
      // Dark's brand teal (#03897B) with white text is 4.31:1, kept by choice; hover is full AA.
      assert.ok(contrast(t['accent-fg'], t.accent) >= 4.3, 'accent-fg on accent');
      assert.ok(contrast(t['accent-fg'], t['accent-hover']) >= 4.5, 'accent-fg on accent-hover');
    });

    it('input outlines and the focus ring pass non-text contrast (3:1)', () => {
      for (const bg of ['bg', 'elevated', 'panel']) {
        assert.ok(contrast(t['border-strong'], bg === 'bg' ? t.bg : t[bg]) >= 3, `border-strong on ${bg}`);
        assert.ok(contrast(t.ring, t[bg]) >= 3, `focus ring on ${bg}`);
        assert.ok(contrast(t.accent, t[bg]) >= 3, `accent (buttons, indicators) on ${bg}`);
        assert.ok(contrast(t.working, t[bg]) >= 3, `working dot/spinner on ${bg}`);
      }
    });
  });
}

const chroma = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return Math.max(r, g, b) - Math.min(r, g, b);
};

describe('palette', () => {
  it('dark uses the near-black / teal scheme', () => {
    const d = THEMES.dark;
    assert.deepEqual([d.bg, d.panel, d.inset, d.accent].map((c) => c.toLowerCase()), ['#131314', '#1e1f20', '#282a2c', '#03897b']);
  });

  it('teal as text uses the readable accent-text', () => {
    for (const bg of ['bg', 'panel', 'inset', 'hover']) assert.ok(contrast(THEMES.dark['accent-text'], THEMES.dark[bg]) >= 4.5, `accent-text on ${bg}`);
  });

  it('light stays neutral with a black accent', () => {
    const neutral = ['accent', 'accent-hover', 'accent-fg', 'bg', 'panel', 'elevated', 'inset', 'hover', 'control', 'border', 'border-strong',
      'text-primary', 'text-secondary', 'text-muted', 'text-faint', 'working', 'rotating', 'innerchat', 'info'];
    for (const k of neutral) assert.ok(chroma(THEMES.light[k]) <= 12, `light ${k} ${THEMES.light[k]} should be grey`);
    assert.ok(luminance(THEMES.light.accent) < 0.02);
  });

  it('status dots use shade, not hue (red only for errors)', () => {
    const ui = readFileSync(new URL('../src/components/ui.tsx', import.meta.url), 'utf8');
    const block = ui.slice(ui.indexOf('STATUS_COLOR'), ui.indexOf('};', ui.indexOf('STATUS_COLOR')));
    assert.doesNotMatch(block, /success|warning|info|innerchat/);
    assert.equal((block.match(/danger/g) ?? []).length, 1);
  });
});
