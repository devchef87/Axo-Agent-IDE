// File API for the editor: tree, read/write, raw streaming, upload, rename/delete,
// filename search, git status/diff. Every path goes through confine() first.
import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { basename, dirname, extname, join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  DiffRes, FileContent, FileDiff, FileEntry, FileSearchRes, FileTree, GitFileStatus, GitStatusRes, OriginalRes, UploadRes, WriteFileRes,
} from '@axo/protocol';
import { HttpError } from '../util/http-error.ts';
import { confine, toRel } from './paths.ts';

export const MAX_TEXT_BYTES = 5 * 1024 * 1024;   // larger files open read-only via raw
export const MAX_WRITE_BYTES = 20 * 1024 * 1024;
const MAX_UPLOAD_FILES = 50;
const HIDDEN = new Set(['.git', 'node_modules', '.DS_Store', '__pycache__', '.venv', '.next', '.nuxt', '.cache', '.turbo']);
const SEARCH_SKIP = new Set([...HIDDEN, 'dist', 'build', 'coverage', 'target', 'vendor']);

const LANG: Record<string, string> = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  css: 'css', scss: 'css', less: 'css', html: 'html', htm: 'html', vue: 'html', svelte: 'html', json: 'json', jsonc: 'json',
  md: 'markdown', mdx: 'markdown', py: 'python', rs: 'rust', go: 'go', sh: 'shell', bash: 'shell', zsh: 'shell',
  yaml: 'yaml', yml: 'yaml', toml: 'toml', sql: 'sql', xml: 'xml', svg: 'xml', java: 'java', kt: 'kotlin', swift: 'swift',
  c: 'cpp', h: 'cpp', cc: 'cpp', cpp: 'cpp', hpp: 'cpp', rb: 'ruby', php: 'php',
};
export function languageFor(name: string): string {
  const lower = name.toLowerCase();
  if (lower === 'dockerfile') return 'dockerfile';
  if (lower === 'makefile') return 'makefile';
  return LANG[extname(lower).slice(1)] ?? 'text';
}

export const MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.bmp': 'image/bmp',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.ogv': 'video/ogg',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.flac': 'audio/flac',
  '.pdf': 'application/pdf', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
  '.html': 'text/plain; charset=utf-8', // never render project HTML as a document from the node origin
};

function git(cwd: string, args: string[], maxBuffer = 16 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: 15_000, maxBuffer }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

async function statOr404(full: string) {
  try { return await stat(full); } catch { throw new HttpError(404, 'not found'); }
}

export async function tree(root: string, rel: string): Promise<FileTree> {
  const dir = confine(root, rel);
  const st = await statOr404(dir);
  if (!st.isDirectory()) throw new HttpError(400, 'not a directory');
  const raw = await readdir(dir, { withFileTypes: true });
  const entries: FileEntry[] = [];
  for (const e of raw) {
    if (HIDDEN.has(e.name)) continue;
    const full = join(dir, e.name);
    let isDir = e.isDirectory(), isFile = e.isFile();
    if (e.isSymbolicLink()) {
      try {
        const s = await stat(full);
        isDir = s.isDirectory(); isFile = s.isFile();
        confine(root, toRel(root, full)); // skip links that leave the root
      } catch { continue; }
    }
    if (isDir) {
      let hasChildren = false;
      try { hasChildren = (await readdir(full)).some((n) => !HIDDEN.has(n)); } catch { /* unreadable */ }
      entries.push({ name: e.name, path: toRel(root, full), dir: true, hasChildren });
    } else if (isFile) {
      let size = 0;
      try { size = (await stat(full)).size; } catch { /* raced */ }
      entries.push({ name: e.name, path: toRel(root, full), dir: false, size });
    }
  }
  entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) : a.dir ? -1 : 1));
  return { root, path: toRel(root, dir), entries };
}

export async function read(root: string, rel: string): Promise<FileContent> {
  const full = confine(root, rel);
  const st = await statOr404(full);
  if (!st.isFile()) throw new HttpError(400, 'not a file');
  const base = { path: toRel(root, full), size: st.size, mtime: st.mtimeMs, language: languageFor(basename(full)) };
  if (st.size > MAX_TEXT_BYTES) return { ...base, content: null, binary: false };
  const buf = await readFile(full);
  if (buf.subarray(0, 8192).includes(0)) return { ...base, content: null, binary: true };
  return { ...base, content: buf.toString('utf8'), binary: false };
}

export async function write(root: string, rel: string, content: unknown, baseMtime?: number): Promise<WriteFileRes> {
  if (typeof content !== 'string') throw new HttpError(400, 'content must be a string');
  if (Buffer.byteLength(content) > MAX_WRITE_BYTES) throw new HttpError(413, 'content too large');
  if (!rel) throw new HttpError(400, 'path required');
  const full = confine(root, rel);
  if (baseMtime != null) {
    // Optimistic concurrency: agents edit these files too.
    try {
      const cur = await stat(full);
      if (Math.abs(cur.mtimeMs - baseMtime) > 1) throw new HttpError(409, 'file changed on disk since it was opened');
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(409, 'file was deleted since it was opened');
    }
  }
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, content, 'utf8');
  const st = await stat(full);
  return { path: toRel(root, full), size: st.size, mtime: st.mtimeMs };
}

export async function create(root: string, rel: string, isDir: boolean, content = ''): Promise<{ path: string }> {
  if (!rel) throw new HttpError(400, 'path required');
  const full = confine(root, rel);
  try { await stat(full); throw new HttpError(409, 'already exists'); } catch (e) { if (e instanceof HttpError) throw e; }
  if (isDir) await mkdir(full, { recursive: true });
  else {
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, typeof content === 'string' ? content : '', { flag: 'wx' });
  }
  return { path: toRel(root, full) };
}

export async function renamePath(root: string, from: string, to: string): Promise<{ from: string; to: string }> {
  if (!from || !to) throw new HttpError(400, 'from and to required');
  const a = confine(root, from), b = confine(root, to);
  if (a === root) throw new HttpError(400, 'cannot rename the project root');
  await statOr404(a);
  try { await stat(b); throw new HttpError(409, 'destination exists'); } catch (e) { if (e instanceof HttpError) throw e; }
  await mkdir(dirname(b), { recursive: true });
  await rename(a, b);
  return { from: toRel(root, a), to: toRel(root, b) };
}

export async function remove(root: string, rel: string): Promise<{ path: string }> {
  const full = confine(root, rel);
  if (full === root) throw new HttpError(400, 'cannot delete the project root');
  await statOr404(full);
  await rm(full, { recursive: true, force: true });
  return { path: toRel(root, full) };
}

export async function upload(root: string, dir: string, files: unknown): Promise<UploadRes> {
  if (!Array.isArray(files) || files.length === 0) throw new HttpError(400, 'files[] required');
  if (files.length > MAX_UPLOAD_FILES) throw new HttpError(400, `max ${MAX_UPLOAD_FILES} files per upload`);
  const target = confine(root, dir);
  const uploaded: UploadRes['uploaded'] = [];
  for (const f of files as { name?: unknown; content?: unknown }[]) {
    const name = typeof f?.name === 'string' ? basename(f.name.replace(/\\/g, '/')) : '';
    if (!name || name === '.' || name === '..' || typeof f.content !== 'string') continue;
    const full = confine(root, toRel(root, join(target, name)));
    const buf = Buffer.from(f.content, 'base64');
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, buf);
    uploaded.push({ path: toRel(root, full), size: buf.length });
  }
  return { uploaded };
}

/** Filename search: subsequence match, shortest/earliest first. Bounded walk. */
export async function search(root: string, q: string, limit = 50): Promise<FileSearchRes> {
  const query = q.trim().toLowerCase();
  if (!query) return { files: [] };
  if (query.length > 200) throw new HttpError(400, 'query too long');
  const max = Math.min(Math.max(limit, 1), 200);
  const hits: { path: string; name: string; score: number }[] = [];
  let visited = 0;
  const score = (name: string, path: string): number | null => {
    const n = name.toLowerCase();
    const i = n.indexOf(query);
    if (i !== -1) return 1000 - i * 10 - n.length;
    const hay = path.toLowerCase();
    let at = 0, s = 0;
    for (const ch of query) {
      const j = hay.indexOf(ch, at);
      if (j === -1) return null;
      s -= j - at;
      at = j + 1;
    }
    return s - hay.length;
  };
  const walk = async (dir: string): Promise<void> => {
    if (visited > 20_000) return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (SEARCH_SKIP.has(e.name) || e.name.startsWith('.')) continue;
      visited++;
      const full = join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile()) {
        const rel = toRel(root, full);
        const s = score(e.name, rel);
        if (s !== null) hits.push({ path: rel, name: e.name, score: s });
      }
    }
  };
  await walk(root);
  hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return { files: hits.slice(0, max).map(({ path, name }) => ({ path, name })) };
}

export async function gitStatus(root: string): Promise<GitStatusRes> {
  let out: string;
  try {
    out = await git(root, ['status', '--porcelain=v1', '-z', '--branch', '--untracked-files=all']);
  } catch {
    return { isRepo: false, branch: null, entries: [] };
  }
  const parts = out.split('\0');
  let branch: string | null = null;
  const entries: GitStatusRes['entries'] = [];
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (!rec) continue;
    if (rec.startsWith('## ')) { branch = rec.slice(3).split('...')[0].replace(/^No commits yet on /, '') || null; continue; }
    const x = rec[0], y = rec[1], path = rec.slice(3);
    if (x === 'R' || x === 'C') i++; // rename/copy: next record is the old path
    const code = x === '?' ? '?' : x === 'U' || y === 'U' ? 'U' : x !== ' ' ? x : y;
    const status = (['M', 'A', 'D', 'R', 'U', '?'] as const).includes(code as GitFileStatus) ? (code as GitFileStatus) : 'M';
    entries.push({ path, status });
  }
  return { isRepo: true, branch, entries };
}

export function parseDiff(raw: string): FileDiff[] {
  if (!raw.trim()) return [];
  return raw.split(/^diff --git /m).filter((c) => c.trim()).map((chunk) => {
    const lines = chunk.split('\n');
    const m = lines[0].match(/^a\/(.+?) b\/(.+)$/);
    const path = m ? m[2] : lines[0];
    let status: FileDiff['status'] = 'modified';
    if (lines.some((l) => l.startsWith('new file mode'))) status = 'added';
    else if (lines.some((l) => l.startsWith('deleted file mode'))) status = 'deleted';
    let additions = 0, deletions = 0, inHunk = false;
    for (const l of lines) {
      if (l.startsWith('@@')) inHunk = true;
      else if (inHunk && l.startsWith('+')) additions++;
      else if (inHunk && l.startsWith('-')) deletions++;
    }
    return { path, status, additions, deletions, patch: 'diff --git ' + chunk.replace(/\n$/, '') };
  });
}

/** Working tree vs HEAD (staged + unstaged), optionally for one path. */
export async function diff(root: string, rel?: string): Promise<DiffRes> {
  const args = ['diff', 'HEAD', '--no-color', '--no-ext-diff'];
  if (rel) args.push('--', toRel(root, confine(root, rel)));
  try {
    return { diffs: parseDiff(await git(root, args)) };
  } catch {
    // No HEAD yet (fresh repo) or not a repo.
    try {
      const cached = ['diff', '--cached', '--no-color', '--no-ext-diff', ...(rel ? ['--', rel] : [])];
      return { diffs: parseDiff(await git(root, cached)) };
    } catch {
      return { diffs: [] };
    }
  }
}

export async function original(root: string, rel: string): Promise<OriginalRes> {
  const path = toRel(root, confine(root, rel));
  try {
    return { path, content: await git(root, ['show', `HEAD:./${path}`]) };
  } catch {
    return { path, content: null };
  }
}

/** Stream a file with Range support (video seeking, pdf.js partial loads). */
export async function sendRaw(root: string, rel: string, req: IncomingMessage, res: ServerResponse, download = false): Promise<void> {
  const full = confine(root, rel);
  const st = await statOr404(full);
  if (!st.isFile()) throw new HttpError(400, 'not a file');
  const name = basename(full);
  const headers: Record<string, string | number> = {
    'Content-Type': MIME[extname(name).toLowerCase()] ?? 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
    'Last-Modified': st.mtime.toUTCString(),
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  };
  if (download) headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(name)}`;

  const range = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
  if (range && st.size > 0) {
    let start = range[1] ? Number(range[1]) : NaN;
    let end = range[2] ? Number(range[2]) : st.size - 1;
    if (Number.isNaN(start)) { start = Math.max(0, st.size - end); end = st.size - 1; } // suffix range
    if (start > end || start >= st.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }).end();
      return;
    }
    end = Math.min(end, st.size - 1);
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') { res.end(); return; }
    return pipe(createReadStream(full, { start, end }), res);
  }
  res.writeHead(200, { ...headers, 'Content-Length': st.size });
  if (req.method === 'HEAD') { res.end(); return; }
  return pipe(createReadStream(full), res);
}

function pipe(src: ReturnType<typeof createReadStream>, res: ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    src.on('error', () => { res.destroy(); resolve(); });
    res.on('close', () => { src.destroy(); resolve(); }); // client aborted (normal when seeking)
    src.pipe(res);
  });
}

