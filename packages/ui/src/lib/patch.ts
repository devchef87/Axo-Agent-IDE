// Unified diff → per-file line lists for the merge review. Pure and unit-tested.

export type LineType = 'add' | 'del' | 'ctx' | 'hunk' | 'note';
export interface PatchLine { type: LineType; text: string; oldNo: number | null; newNo: number | null }
export interface PatchFile { path: string; oldPath: string | null; status: 'added' | 'deleted' | 'renamed' | 'modified'; binary: boolean; lines: PatchLine[] }

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function parsePatch(patch: string): PatchFile[] {
  const files: PatchFile[] = [];
  let cur: PatchFile | null = null;
  let oldNo = 0, newNo = 0, inHunk = false;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      cur = { path: m ? m[2] : line.slice(11), oldPath: null, status: 'modified', binary: false, lines: [] };
      files.push(cur);
      inHunk = false;
      continue;
    }
    if (!cur) continue;
    if (!inHunk) {
      if (line.startsWith('new file mode')) cur.status = 'added';
      else if (line.startsWith('deleted file mode')) cur.status = 'deleted';
      else if (line.startsWith('rename from ')) { cur.status = 'renamed'; cur.oldPath = line.slice(12); }
      else if (line.startsWith('Binary files ') || line === 'GIT binary patch') cur.binary = true;
    }
    const h = HUNK.exec(line);
    if (h) {
      inHunk = true;
      oldNo = Number(h[1]);
      newNo = Number(h[2]);
      cur.lines.push({ type: 'hunk', text: line, oldNo: null, newNo: null });
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('+')) cur.lines.push({ type: 'add', text: line.slice(1), oldNo: null, newNo: newNo++ });
    else if (line.startsWith('-')) cur.lines.push({ type: 'del', text: line.slice(1), oldNo: oldNo++, newNo: null });
    else if (line.startsWith(' ')) cur.lines.push({ type: 'ctx', text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
    else if (line.startsWith('\\')) cur.lines.push({ type: 'note', text: line, oldNo: null, newNo: null });
  }
  return files;
}

/** Relative size bar for a file row: [added, removed] out of `width` blocks. */
export function changeBar(additions: number, deletions: number, width = 5): [number, number] {
  const total = additions + deletions;
  if (!total) return [0, 0];
  const scale = Math.min(width, total) / total;
  const add = Math.round(additions * scale);
  return [add, Math.min(width, total) - add];
}
