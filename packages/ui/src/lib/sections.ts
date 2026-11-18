/**
 * Split a markdown reply into sections at headings (#, ##, ###), so each section gets its own short
 * accent rule instead of one line down a long reply. Lines inside ``` fences never start a section.
 * Text before the first heading is its own section.
 */
export function splitSections(md: string): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  let fence = false;
  for (const line of md.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (!fence && /^#{1,3}\s/.test(line) && cur.some((l) => l.trim())) {
      out.push(cur.join('\n'));
      cur = [];
    }
    cur.push(line);
  }
  if (cur.some((l) => l.trim())) out.push(cur.join('\n'));
  return out.length ? out : [md];
}
