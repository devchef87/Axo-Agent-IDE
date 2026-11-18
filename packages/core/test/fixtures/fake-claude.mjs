#!/usr/bin/env node
// Fake `claude -p --input-format stream-json` for tests. Behaviour is driven by keywords in the user message:
//   TOOL   → emits a Bash tool_use + tool_result before replying
//   IMAGE  → emits a Read tool_use whose tool_result contains a PNG image block
//   SLOW   → takes 1.5s; honours control_request interrupt
//   STUCK  → takes 30s and ignores interrupts
//   CRASH  → exits(1) mid-turn
//   RECALL → replies with the number of prior user messages in this session
//   SILENT → ends the turn without any assistant text
// Sessions persist in $FAKE_CLAUDE_DIR/<session>.json so --resume works across processes.
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const dir = process.env.FAKE_CLAUDE_DIR;
const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i === -1 ? null : args[i + 1]; };
const { AXO_AGENT_ID, AXO_TOKEN, AXO_NODE_URL, PATH } = process.env;
// Optional-flag probes aren't spawns; behave like an older claude that doesn't know the flag.
if (args.includes('--thinking-display')) { process.stderr.write("error: unknown option '--thinking-display'\n"); process.exit(1); }
appendFileSync(join(dir, 'spawns.log'), JSON.stringify({ args, pid: process.pid, cwd: process.cwd(), env: { AXO_AGENT_ID, AXO_TOKEN, AXO_NODE_URL, PATH } }) + '\n');

// Headless one-shot mode (journalist): `-p --output-format json` without stream input.
// Responds with the first matching rule from $FAKE_CLAUDE_DIR/headless.json ([{match, reply}]) or a default.
if (flag('--output-format') === 'json') {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { input += d; });
  process.stdin.on('end', () => {
    const system = flag('--system-prompt') ?? '';
    appendFileSync(join(dir, 'headless.log'), JSON.stringify({ system, prompt: input, model: flag('--model') }) + '\n');
    const rulesFile = join(dir, 'headless.json');
    const rules = existsSync(rulesFile) ? JSON.parse(readFileSync(rulesFile, 'utf8')) : [];
    const hit = rules.find((r) => (system + '\n' + input).includes(r.match));
    process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: hit ? hit.reply : `HEADLESS_OK ${input.length}`, total_cost_usd: 0.001 }));
  });
} else {
  main();
}

function main() {
const resume = flag('--resume');
const sessionId = resume ?? flag('--session-id');
const file = join(dir, `${sessionId}.json`);
if (resume && !existsSync(file)) {
  process.stderr.write(`No conversation found with session ID: ${resume}\n`);
  process.exit(1);
}
const history = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');

let busy = null; // { interrupt: () => void }
let n = 0;
const rl = createInterface({ input: process.stdin });

rl.on('line', async (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'control_request') {
    out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: {} } });
    busy?.interrupt();
    return;
  }
  if (msg.type !== 'user') return;
  const text = msg.message.content.map((b) => b.text ?? '').join('');
  queue.push(text);
  if (!busy) drain();
});

const queue = [];
async function drain() {
  while (queue.length) await turn(queue.shift());
}

async function turn(text) {
  const prior = history.length;
  history.push(text);
  writeFileSync(file, JSON.stringify(history));
  out({ type: 'system', subtype: 'init', session_id: sessionId, model: flag('--model'), cwd: process.cwd(), tools: [] });
  const id = `msg_${++n}_${process.pid}`;
  const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 1000 * (prior + 1), cache_creation_input_tokens: 100 };

  if (/CRASH/.test(text)) { process.stderr.write('boom: simulated crash\n'); process.exit(1); }

  if (/TOOL/.test(text)) {
    out({ type: 'assistant', message: { id, content: [{ type: 'tool_use', id: `tu_${n}`, name: 'Bash', input: { command: 'echo hi', description: 'Say hi' } }], usage } });
    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `tu_${n}`, content: 'hi', is_error: false }] } });
  }

  if (/IMAGE/.test(text)) {
    // 1×1 transparent PNG
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    out({ type: 'assistant', message: { id: `${id}_img`, content: [{ type: 'tool_use', id: `tu_img_${n}`, name: 'Read', input: { file_path: process.cwd() + '/shot.png' } }], usage } });
    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `tu_img_${n}`, is_error: false, content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } },
    ] }] } });
  }

  let interrupted = false;
  if (/SLOW|STUCK/.test(text)) {
    const ms = /STUCK/.test(text) ? 30_000 : 1500;
    await new Promise((res) => {
      const t = setTimeout(res, ms);
      busy = { interrupt: () => { if (/STUCK/.test(text)) return; interrupted = true; clearTimeout(t); res(); } };
    });
    busy = null;
  }
  if (interrupted) {
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, duration_ms: 10, duration_api_ms: 5, num_turns: 1, session_id: sessionId, total_cost_usd: 0, usage });
    return;
  }

  if (/SILENT/.test(text)) {
    out({ type: 'result', subtype: 'success', is_error: false, duration_ms: 5, duration_api_ms: 1, num_turns: 1, session_id: sessionId, total_cost_usd: 0, usage });
    return;
  }
  const reply = /RECALL/.test(text) ? `prior=${prior}` : `echo: ${text}`;
  out({ type: 'stream_event', event: { type: 'message_start', message: { id: `${id}b` } } });
  out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: reply } } });
  out({ type: 'assistant', message: { id: `${id}b`, content: [{ type: 'text', text: reply }], usage } });
  out({ type: 'result', subtype: 'success', is_error: false, duration_ms: 20, duration_api_ms: 10, num_turns: 1, session_id: sessionId, total_cost_usd: 0.001, usage });
}

rl.on('close', async () => {
  while (busy || queue.length) await new Promise((r) => setTimeout(r, 20));
  process.exit(0);
});
}
