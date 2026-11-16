// axo: the CLI agents use to reach their team. Zero dependencies (node builtins only).
// Identity comes from the environment the node gives every agent:
//   AXO_NODE_URL  node base URL      AXO_TOKEN  this agent's token      AXO_AGENT_ID  this agent's id
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { AskRes, CreateWatchRes, MeRes, TellRes, Watch, WhoRes } from '@axo/protocol';

const HELP = `axo: talk to your team and schedule work from inside an Axo agent

  axo who                              agents you can reach (name, team, status, scope)
  axo ask <agent> "<question>"         ask and WAIT for the answer (prints it)
        [--timeout 5m]                 default 110s, max 9m; give Bash a longer timeout to match
  axo tell <agent> "<message>"         send without waiting; any reply arrives as a message later
  axo watch "<command>"                run a long job detached; you are woken with its exit code
        [--label L] [--timeout 2h]     default timeout 30m, max 24h
  axo watch --until "<check>"          wake me when <check> first exits 0 (polled)
        [--interval 30s]
  axo watch ls                         your watches
  axo watch cancel <id>                cancel a watch (kills its job)
  axo status                           who you are, your team, scope, active watches
  axo rotate [--note "<text>"]         ask for a fresh context at your next turn boundary

Address agents as name (same project), name@team, or name@server (another server, relayed by the Axo app).`;

// ── tiny arg parser ─────────────────────────────────────────

interface Args { _: string[]; flags: Record<string, string | true> }

function parse(argv: string[]): Args {
  const out: Args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { out._.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) { out.flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { out.flags[a.slice(2)] = next; i++; } else out.flags[a.slice(2)] = true;
    } else if (a === '-h') out.flags.help = true;
    else out._.push(a);
  }
  return out;
}

/** "90" (seconds), "90s", "5m", "2h", "1h30m" → ms. */
function parseDuration(s: string): number {
  const t = s.trim();
  if (/^\d+$/.test(t)) return Number(t) * 1000;
  const re = /(\d+(?:\.\d+)?)\s*(ms|s|m|h)/g;
  let total = 0;
  let matched = '';
  for (let m; (m = re.exec(t));) {
    total += Number(m[1]) * ({ ms: 1, s: 1000, m: 60_000, h: 3_600_000 } as Record<string, number>)[m[2]];
    matched += m[0];
  }
  if (!total || matched.replace(/\s/g, '') !== t.replace(/\s/g, '')) throw new Error(`bad duration "${s}" (use e.g. 90s, 5m, 2h)`);
  return total;
}

// ── http ────────────────────────────────────────────────────

class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

function env(name: string): string {
  const v = process.env[name];
  if (!v) {
    fail(`${name} is not set. axo only works inside an agent started by Axo.`);
  }
  return v!;
}

/** node:http rather than fetch: undici's 5-minute header timeout would cut long asks short. */
function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const base = new URL(env('AXO_NODE_URL'));
  const token = env('AXO_TOKEN');
  const url = new URL('/api' + path, base);
  const data = body === undefined ? undefined : JSON.stringify(body);
  const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = request(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: any = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
        if ((res.statusCode ?? 500) >= 400) reject(new ApiError(res.statusCode ?? 500, json?.error ?? (text || `HTTP ${res.statusCode}`)));
        else resolve(json as T);
      });
    });
    req.on('error', (e: any) => reject(new Error(`cannot reach the Axo node at ${base.origin} (${e.code ?? e.message})`)));
    if (data) req.write(data);
    req.end();
  });
}

function fail(msg: string, code = 1): never {
  process.stderr.write(`axo: ${msg}\n`);
  process.exit(code);
}

function need(v: string | undefined, usage: string): string {
  if (!v || !v.trim()) fail(`usage: ${usage}`);
  return v!;
}

const dot = (s: string) => (s === 'working' ? '●' : s === 'idle' || s === 'starting' ? '○' : '·');

// ── commands ────────────────────────────────────────────────

async function who(): Promise<void> {
  const res = await api<WhoRes>('GET', '/innerchat/who');
  const others = res.agents.filter((a) => !a.you);
  if (!others.length) console.log('No other agents in this project yet.');
  else {
    console.log(`You are ${res.you ?? '?'}. Agents you can message:`);
    for (const a of others) {
      const scope = a.scope.length ? `  scope: ${a.scope.join(', ')}` : '';
      console.log(`  ${dot(a.status)} ${a.name}  (${a.role}, team ${a.team}, ${a.status})${scope}`);
    }
  }
  if (res.servers?.length) {
    console.log('\nServers (message an agent there as name@server):');
    for (const sv of res.servers) console.log(`  ${sv.connected ? '●' : '○'} ${sv.id}${sv.name !== sv.id ? `  (${sv.name})` : ''}${sv.connected ? '' : '  disconnected: messages wait until it reconnects'}`);
  }
  console.log('\naxo ask <name> "<question>"   blocks until they answer');
  console.log('axo tell <name> "<message>"   returns immediately');
}

async function ask(a: Args): Promise<void> {
  const usage = 'axo ask <agent> "<question>" [--timeout 5m]';
  const to = need(a._[1], usage);
  const message = need(a._.slice(2).join(' '), usage);
  const timeoutMs = typeof a.flags.timeout === 'string' ? parseDuration(a.flags.timeout) : undefined;
  process.stderr.write(`axo: asking ${to}; this blocks until they answer (up to ${Math.round((timeoutMs ?? 110_000) / 1000)}s). For long waits use \`axo tell\`.\n`);
  const res = await api<AskRes>('POST', '/innerchat/ask', { to, message, timeoutMs });
  if (res.reply !== null) {
    console.log(res.reply);
  } else {
    console.log(`[no answer] ${res.note ?? ''}`.trim());
  }
  if (res.exchangesRemaining <= 5) process.stderr.write(`axo: rapid back-and-forth detected; ${res.exchangesRemaining} more quick message(s) before this pair is paused as a loop\n`);
}

async function tell(a: Args): Promise<void> {
  const usage = 'axo tell <agent> "<message>"';
  const to = need(a._[1], usage);
  const message = need(a._.slice(2).join(' '), usage);
  const res = await api<TellRes>('POST', '/innerchat/tell', { to, message });
  console.log(`Delivered to ${to}. Their reply, if any, will arrive as a message; you don't need to wait.${res.exchangesRemaining <= 5 ? ` (rapid back-and-forth: ${res.exchangesRemaining} more before a loop pause)` : ''}`);
}

function fmtWatch(w: Watch): string {
  const age = Math.round((Date.now() - w.createdAt) / 60_000);
  const res = w.result ? `, ${w.result.outcome}${w.result.exitCode !== null ? ` (exit ${w.result.exitCode})` : ''}` : '';
  return `  ${w.id}  ${w.status}${res}  ${w.mode === 'until' ? 'until' : 'run'}: ${w.label}  (${age}m ago)`;
}

async function watch(a: Args): Promise<void> {
  const sub = a._[1];
  if (sub === 'ls' && a._.length === 2) {
    const list = await api<Watch[]>('GET', '/watches');
    if (!list.length) console.log('No watches.');
    for (const w of list.slice(0, 30)) console.log(fmtWatch(w));
    return;
  }
  if (sub === 'cancel' && a._.length === 3) {
    const w = await api<Watch>('POST', `/watches/${encodeURIComponent(a._[2])}/cancel`);
    console.log(`Cancelled ${w.id} (${w.label}).`);
    return;
  }
  const command = a._.slice(1).join(' ').trim();
  const until = typeof a.flags.until === 'string' ? a.flags.until : '';
  if (!command && !until) fail('usage: axo watch "<command>" [--label L] [--timeout 2h]   or   axo watch --until "<check>"');
  if (command && until) fail('give a command OR --until "<check>", not both');
  const body = {
    command: command || undefined,
    until: until || undefined,
    label: typeof a.flags.label === 'string' ? a.flags.label : undefined,
    timeoutMs: typeof a.flags.timeout === 'string' ? parseDuration(a.flags.timeout) : undefined,
    intervalMs: typeof a.flags.interval === 'string' ? parseDuration(a.flags.interval) : undefined,
  };
  const res = await api<CreateWatchRes>('POST', '/watches', body);
  const w = res.watch;
  if (res.reattached) {
    console.log(`Already running as watch ${w.id}; not starting a second copy. You will be woken when it finishes.`);
    return;
  }
  console.log(w.mode === 'command'
    ? `Watch ${w.id} started: "${w.label}". It runs detached in ${w.cwd}; you will get a message with the exit code and output tail when it finishes. End your turn now instead of waiting.`
    : `Watch ${w.id} armed: you will get a message when \`${w.until}\` first succeeds. End your turn now instead of waiting.`);
}

async function status(): Promise<void> {
  const me = await api<MeRes>('GET', '/me');
  const { agent, team, project } = me;
  console.log(`${agent.name} (${agent.role}), id ${agent.id}`);
  console.log(`project ${project.name}  team ${team.name} (${team.mode}${team.branch ? `, branch ${team.branch}` : ''})`);
  console.log(`workdir ${agent.workdir}`);
  console.log(`scope   ${agent.scopeGlobs.length ? agent.scopeGlobs.join(', ') : '(none: whole workdir, except teammates\' scopes)'}`);
  console.log(`context ${Math.round(agent.contextTokens / 1000)}k / ${Math.round(agent.contextWindow / 1000)}k tokens`);
  if (me.teammates.length) {
    console.log('teammates');
    for (const t of me.teammates) console.log(`  ${dot(t.status)} ${t.name} (${t.role}, team ${t.team})${t.scope.length ? `  scope: ${t.scope.join(', ')}` : ''}`);
  }
  console.log(me.watches.length ? 'active watches' : 'no active watches');
  for (const w of me.watches) console.log(fmtWatch(w));
}

async function rotate(a: Args): Promise<void> {
  const id = env('AXO_AGENT_ID');
  const note = typeof a.flags.note === 'string' ? a.flags.note : undefined;
  try {
    await api('POST', `/agents/${encodeURIComponent(id)}/refresh`, { note, reason: 'requested' });
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) fail('a refresh is already in progress.');
    throw e;
  }
  console.log('Rotation requested. It happens at your next turn boundary; finish this turn normally.');
}

async function main(): Promise<void> {
  const a = parse(process.argv.slice(2));
  const cmd = a._[0];
  if (!cmd || cmd === 'help' || a.flags.help) { console.log(HELP); return; }
  switch (cmd) {
    case 'who': return who();
    case 'ask': return ask(a);
    case 'tell': return tell(a);
    case 'watch': return watch(a);
    case 'watches': return watch({ ...a, _: ['watch', 'ls'] });
    case 'status': return status();
    case 'rotate': return rotate(a);
    default: fail(`unknown command "${cmd}". Run \`axo help\`.`);
  }
}

main().catch((e: Error) => fail(e.message));
