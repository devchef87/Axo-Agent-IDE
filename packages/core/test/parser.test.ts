import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseLine, ParseContext, summarizeTool } from '../src/runtime/parser.ts';

describe('parser', () => {
  it('maps init, assistant blocks, usage, tool results and result', () => {
    const ctx = new ParseContext('/repo');
    assert.deepEqual(parseLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1', model: 'opus' }), ctx),
      [{ type: 'session', sessionId: 's1', model: 'opus' }]);

    const acts = parseLine(JSON.stringify({ type: 'assistant', message: { id: 'm1', content: [
      { type: 'thinking', thinking: '...' },
      { type: 'text', text: 'Hello' },
      { type: 'tool_use', id: 'tu1', name: 'Edit', input: { file_path: '/repo/src/a.ts', old_string: 'a', new_string: 'b' } },
    ], usage: { input_tokens: 3, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50, output_tokens: 9 } } }), ctx, 5);
    assert.deepEqual(acts[0], { type: 'feed', item: { kind: 'text', id: 't-m1-1', ts: 5, text: 'Hello' } });
    assert.equal((acts[1] as any).item.summary, 'src/a.ts');
    assert.deepEqual(acts[2], { type: 'context', tokens: 1053 });

    const tr = parseLine(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', is_error: true, content: [{ type: 'text', text: 'nope' }] }] } }), ctx, 7);
    assert.deepEqual(tr, [{ type: 'tool-result', toolUseId: 'tu1', isError: true, content: 'nope', ts: 7 }]);

    const end = parseLine(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, duration_ms: 10, duration_api_ms: 8, num_turns: 2, total_cost_usd: 0.5, usage: { input_tokens: 1, output_tokens: 2 } }), ctx)[0] as any;
    assert.equal(end.type, 'turn-end');
    assert.equal(end.usage.costUsd, 0.5);
  });

  it('numbers blocks consistently across split assistant events (matches stream indices)', () => {
    const ctx = new ParseContext('/');
    parseLine(JSON.stringify({ type: 'assistant', message: { id: 'm', content: [{ type: 'thinking' }] } }), ctx);
    const a = parseLine(JSON.stringify({ type: 'assistant', message: { id: 'm', content: [{ type: 'text', text: 'x' }] } }), ctx);
    assert.equal((a[0] as any).item.id, 't-m-1');
    parseLine(JSON.stringify({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm' } } }), ctx);
    const d = parseLine(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'x' } } }), ctx);
    assert.deepEqual(d, [{ type: 'text-delta', itemId: 't-m-1', text: 'x' }]);
  });

  it('ignores subagent usage for context and tolerates garbage', () => {
    const ctx = new ParseContext('/');
    const acts = parseLine(JSON.stringify({ type: 'assistant', parent_tool_use_id: 'x', message: { id: 'm', content: [], usage: { input_tokens: 99 } } }), ctx);
    assert.deepEqual(acts, []);
    assert.deepEqual(parseLine('not json', ctx), []);
  });

  it('summarizes common tools', () => {
    assert.equal(summarizeTool('Bash', { command: 'npm test\nmore' }, '/'), 'npm test');
    assert.equal(summarizeTool('Grep', { pattern: 'foo', path: '/r/src' }, '/r'), 'foo in src');
    assert.equal(summarizeTool('Read', { file_path: '/elsewhere/x' }, '/r'), '/elsewhere/x');
  });
});
