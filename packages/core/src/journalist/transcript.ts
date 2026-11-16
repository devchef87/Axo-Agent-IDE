import type { FeedItem } from '@axo/protocol';

const cap = (s: string, n: number) => (s.length > n ? s.slice(0, n) + ' …' : s);

/**
 * Compact, faithful transcript of feed items for the journalist. Keeps the
 * newest content when over budget (the end of a session matters most), but
 * always keeps user messages, since they carry the requirements.
 */
export function renderTranscript(items: FeedItem[], maxChars: number): string {
  const lines: { text: string; user: boolean }[] = [];
  for (const i of items) {
    switch (i.kind) {
      case 'user':
        lines.push({ user: true, text: `USER${i.author !== 'user' ? ` (from ${i.author})` : ''}: ${cap(i.text, 3000)}` });
        break;
      case 'text':
        lines.push({ user: false, text: `AGENT: ${cap(i.text, 2000)}` });
        break;
      case 'tool': {
        let t = `TOOL ${i.tool}: ${i.summary}`;
        if (i.status === 'error' && i.result) t += `  [FAILED: ${cap(i.result.split('\n').slice(0, 3).join(' '), 300)}]`;
        lines.push({ user: false, text: t });
        break;
      }
      case 'system':
        if (i.level !== 'info') lines.push({ user: false, text: `NOTE: ${cap(i.text, 300)}` });
        break;
      default:
        break;
    }
  }
  let total = lines.reduce((n, l) => n + l.text.length + 1, 0);
  // Drop the oldest non-user lines first, then the oldest user lines.
  for (const pass of [false, true]) {
    for (let k = 0; k < lines.length && total > maxChars; k++) {
      if (lines[k].user === pass && lines[k].text !== '…') {
        total -= lines[k].text.length - 1;
        lines[k] = { user: pass, text: '…' };
      }
    }
  }
  return lines.map((l) => l.text).join('\n').replace(/(?:…\n)+…/g, '…');
}

/** The last N user↔agent exchanges, verbatim-ish, for handoffs. */
export function recentExchanges(items: FeedItem[], n = 6, perMsg = 2500): string {
  const conv = items.filter((i) => i.kind === 'user' || i.kind === 'text') as Extract<FeedItem, { kind: 'user' | 'text' }>[];
  const out: string[] = [];
  let users = 0;
  for (let k = conv.length - 1; k >= 0 && users < n; k--) {
    const i = conv[k];
    if (i.kind === 'user') { users++; out.unshift(`**${i.author === 'user' ? 'User' : i.author}:** ${cap(i.text, perMsg)}`); }
    else out.unshift(`**You:** ${cap(i.text, perMsg)}`);
  }
  return out.join('\n\n');
}
