// Pure translation of Claude Code stream-json events into Axo actions.
// No I/O here — the runtime applies the actions.

import type { FeedItem } from '@axo/protocol';
import { relative, isAbsolute } from 'node:path';
import { realpathSync } from 'node:fs';

export interface TurnUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  costUsd: number;
}

export type Action =
  | { type: 'session'; sessionId: string; model: string | null }
  | { type: 'feed'; item: FeedItem }
  | { type: 'text-delta'; itemId: string; text: string }
  | { type: 'tool-result'; toolUseId: string; isError: boolean; content: string; ts: number; images?: ResultImage[] }
  | { type: 'context'; tokens: number }
  | { type: 'compact'; trigger: string | null; preTokens: number | null }
  | { type: 'turn-end'; isError: boolean; subtype: string; durationMs: number; apiDurationMs: number; numTurns: number; usage: TurnUsage; sessionId: string | null }
  | { type: 'control-response'; requestId: string; ok: boolean }
  | { type: 'rate-limit'; info: Record<string, unknown> }
  | { type: 'unknown'; raw: any };

/** Per-process parse state (block numbering, streaming message id). */
export class ParseContext {
  blockCounts = new Map<string, number>();
  streamMsgId: string | null = null;
  readonly cwd: string;
  /** cwd plus its realpath (claude reports realpaths, e.g. /private/var on macOS). */
  readonly roots: string[];
  constructor(cwd: string) {
    this.cwd = cwd;
    let real = cwd;
    try { real = realpathSync(cwd); } catch { /* missing dir */ }
    this.roots = real === cwd ? [cwd] : [cwd, real];
  }
  nextBlock(msgId: string): number {
    const n = this.blockCounts.get(msgId) ?? 0;
    this.blockCounts.set(msgId, n + 1);
    return n;
  }
}

const MAX_INPUT_STR = 20_000;
const MAX_RESULT = 8_000;

export function parseLine(line: string, ctx: ParseContext, now = Date.now()): Action[] {
  let e: any;
  try { e = JSON.parse(line); } catch { return []; }
  if (!e || typeof e !== 'object') return [];

  switch (e.type) {
    case 'system':
      if (e.subtype === 'init') return [{ type: 'session', sessionId: e.session_id, model: e.model ?? null }];
      if (e.subtype === 'compact_boundary') {
        const m = e.compact_metadata ?? {};
        return [{ type: 'compact', trigger: m.trigger ?? null, preTokens: m.pre_tokens ?? null }];
      }
      return []; // thinking_tokens, hooks, etc.

    case 'stream_event': {
      const ev = e.event ?? {};
      if (ev.type === 'message_start') ctx.streamMsgId = ev.message?.id ?? null;
      if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ctx.streamMsgId) {
        return [{ type: 'text-delta', itemId: `t-${ctx.streamMsgId}-${ev.index}`, text: ev.delta.text }];
      }
      return [];
    }

    case 'assistant': {
      const msg = e.message ?? {};
      const msgId: string = msg.id ?? `m${now}`;
      const out: Action[] = [];
      for (const block of Array.isArray(msg.content) ? msg.content : []) {
        const idx = ctx.nextBlock(msgId);
        if (block.type === 'text' && block.text?.trim()) {
          out.push({ type: 'feed', item: { kind: 'text', id: `t-${msgId}-${idx}`, ts: now, text: block.text } });
        } else if (block.type === 'tool_use') {
          const input = clampInput(block.input ?? {});
          out.push({ type: 'feed', item: {
            kind: 'tool', id: block.id, ts: now, tool: block.name,
            summary: summarizeTool(block.name, block.input ?? {}, ctx.roots), input, status: 'running',
          } });
        }
      }
      const u = msg.usage;
      if (u && !e.parent_tool_use_id) {
        const tokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        if (tokens > 0) out.push({ type: 'context', tokens });
      }
      return out;
    }

    case 'user': {
      const content = e.message?.content;
      if (!Array.isArray(content)) return [];
      const out: Action[] = [];
      for (const block of content) {
        if (block.type === 'tool_result') {
          const images = resultImages(block.content);
          out.push({ type: 'tool-result', toolUseId: block.tool_use_id, isError: !!block.is_error,
            content: clamp(stringifyResult(block.content), MAX_RESULT), ts: now, ...(images.length ? { images } : {}) });
        }
      }
      return out;
    }

    case 'result': {
      const u = e.usage ?? {};
      return [{
        type: 'turn-end',
        isError: !!e.is_error,
        subtype: e.subtype ?? 'unknown',
        durationMs: e.duration_ms ?? 0,
        apiDurationMs: e.duration_api_ms ?? 0,
        numTurns: e.num_turns ?? 0,
        sessionId: e.session_id ?? null,
        usage: {
          input: u.input_tokens ?? 0,
          output: u.output_tokens ?? 0,
          cacheRead: u.cache_read_input_tokens ?? 0,
          cacheCreation: u.cache_creation_input_tokens ?? 0,
          costUsd: e.total_cost_usd ?? 0,
        },
      }];
    }

    case 'control_response':
      return [{ type: 'control-response', requestId: e.response?.request_id ?? '', ok: e.response?.subtype === 'success' }];

    case 'rate_limit_event':
      return [{ type: 'rate-limit', info: e.rate_limit_info ?? {} }];

    default:
      return [{ type: 'unknown', raw: e }];
  }
}

// ── helpers ─────────────────────────────────────────────────

export function summarizeTool(name: string, input: Record<string, any>, cwd: string | string[]): string {
  const p = (v: unknown) => (typeof v === 'string' ? relPath(v, cwd) : '');
  switch (name) {
    case 'Bash': return input.description || oneLine(input.command);
    case 'Read': return p(input.file_path);
    case 'Write': return p(input.file_path);
    case 'Edit': case 'MultiEdit': return p(input.file_path);
    case 'NotebookEdit': return p(input.notebook_path);
    case 'Glob': return input.pattern ?? '';
    case 'Grep': return `${input.pattern ?? ''}${input.path ? ` in ${p(input.path)}` : ''}`;
    case 'WebFetch': return input.url ?? '';
    case 'WebSearch': return input.query ?? '';
    case 'Task': case 'Agent': return input.description ?? '';
    case 'TodoWrite': return `${Array.isArray(input.todos) ? input.todos.length : 0} todos`;
    case 'Skill': return input.skill ?? '';
    default: {
      const first = Object.values(input).find((v) => typeof v === 'string') as string | undefined;
      return first ? oneLine(first) : '';
    }
  }
}

function relPath(path: string, roots: string | string[]): string {
  if (!isAbsolute(path)) return path;
  for (const root of Array.isArray(roots) ? roots : [roots]) {
    const r = relative(root, path);
    if (r && !r.startsWith('..') && !isAbsolute(r)) return r;
  }
  return path;
}

function oneLine(s: unknown): string {
  if (typeof s !== 'string') return '';
  const line = s.split('\n')[0];
  return line.length > 160 ? line.slice(0, 157) + '…' : line;
}

/** An image returned by a tool (Read of a PNG, screenshots, …), still base64. */
export interface ResultImage { mediaType: string; data: string }
const MAX_IMAGES_PER_RESULT = 4;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export function resultImages(c: unknown): ResultImage[] {
  if (!Array.isArray(c)) return [];
  const out: ResultImage[] = [];
  for (const b of c as any[]) {
    if (b?.type !== 'image' || b.source?.type !== 'base64' || typeof b.source.data !== 'string') continue;
    if (!IMAGE_TYPES.has(b.source.media_type)) continue;
    out.push({ mediaType: b.source.media_type, data: b.source.data });
    if (out.length >= MAX_IMAGES_PER_RESULT) break;
  }
  return out;
}

function stringifyResult(c: unknown): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c.map((b: any) => (b?.type === 'text' ? b.text : b?.type === 'image' ? '[image]' : '')).join('\n');
  }
  return c == null ? '' : JSON.stringify(c);
}

function clamp(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + `\n… [${s.length - max} more chars]` : s;
}

function clampInput(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    out[k] = typeof v === 'string' ? clamp(v, MAX_INPUT_STR) : v;
  }
  return out;
}

const CONTEXT_WINDOWS: [RegExp, number][] = [
  [/\[1m\]/i, 1_000_000],
];
export function contextWindowFor(model: string): number {
  for (const [re, n] of CONTEXT_WINDOWS) if (re.test(model)) return n;
  return 200_000;
}
