import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FeedItem } from '@axo/protocol';
import { makeNode, call, initRepo, type TestNode } from './helpers.ts';
import { parseSchedule } from '../src/watches/cron.ts';
import { agentToken } from '../src/util/agent-token.ts';

let t: TestNode | undefined;
afterEach(async () => { await t?.stop(); t = undefined; });

const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const fmt = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`; };
const scheduled = (t: TestNode, id: string) =>
  t.feed(id).filter((i): i is Extract<FeedItem, { kind: 'user' }> => i.kind === 'user' && i.author === 'schedule');

describe('cron schedules', () => {
  it('computes the next run in local time', () => {
    const mon0830 = at(2026, 11, 16, 8, 30); // a Monday
    assert.equal(fmt(parseSchedule('0 9 * * *').next(mon0830)), '2026-11-16 9:00');
    assert.equal(fmt(parseSchedule('0 9 * * *').next(at(2026, 11, 16, 9, 0))), '2026-11-17 9:00', 'strictly after');
    assert.equal(fmt(parseSchedule('*/15 * * * *').next(at(2026, 11, 16, 8, 31))), '2026-11-16 8:45');
    assert.equal(fmt(parseSchedule('0 9 * * 1-5').next(at(2026, 11, 20, 10, 0))), '2026-11-23 9:00', 'Friday after 9 → Monday');
    assert.equal(fmt(parseSchedule('30 18 * * mon,wed').next(mon0830)), '2026-11-16 18:30');
    assert.equal(fmt(parseSchedule('0 0 1 * *').next(mon0830)), '2026-12-1 0:00');
    assert.equal(fmt(parseSchedule('@daily').next(mon0830)), '2026-11-17 0:00');
    assert.equal(fmt(parseSchedule('0 12 * jan *').next(mon0830)), '2027-1-1 12:00');
    assert.equal(fmt(parseSchedule('0 0 13 * 5').next(mon0830)), '2026-11-20 0:00', 'dom OR dow when both are set');
    assert.equal(fmt(parseSchedule('0 8 * * 7').next(mon0830)), '2026-11-22 8:00', '7 = Sunday');
    const e = parseSchedule('@every 30m', mon0830);
    assert.equal(fmt(e.next(mon0830)), '2026-11-16 9:00');
    assert.equal(fmt(e.next(at(2026, 11, 16, 9, 1))), '2026-11-16 9:30');
  });

  it('rejects bad schedules with a reason', () => {
    assert.throws(() => parseSchedule('61 * * * *'), /bad minute "61"/);
    assert.throws(() => parseSchedule('every day'), /not a schedule/);
    assert.throws(() => parseSchedule('@every 10s'), /not a schedule|at least 1m/);
    assert.throws(() => parseSchedule('0 0 31 2 *').next(Date.now()), /never fires/);
    assert.throws(() => parseSchedule('0 9 * * 1-x'), /bad day of week/);
  });
});

describe('cron watches', () => {
  async function agent() {
    t = await makeNode();
    const p = t.node.projects.create(t.project);
    return t.node.runtime.create({ projectId: p.id, name: 'ops' });
  }
  const makeDue = (t: TestNode, id: string, ago = 1) =>
    t.node.store.db.prepare('UPDATE watches SET next_run_at = ? WHERE id = ?').run(Date.now() - ago, id);

  it('sends the message each time it is due and stays active with the next run scheduled', async () => {
    const a = await agent();
    const { watch } = t!.node.watches.create({ agentId: a.id, cron: '0 9 * * *', message: 'Post the standup summary.' });
    assert.equal(watch.mode, 'cron');
    assert.equal(watch.status, 'active');
    assert.ok(watch.nextRunAt! > Date.now());
    assert.equal(scheduled(t!, a.id).length, 0, 'not before it is due');

    makeDue(t!, watch.id);
    const first = await t!.waitFor(() => scheduled(t!, a.id)[0]);
    assert.match(first.text, /^\[Scheduled message \(0 9 \* \* \*\), run 1\]\n\nPost the standup summary\.$/);
    const after = t!.node.watches.get(watch.id);
    assert.equal(after.status, 'active');
    assert.equal(after.runs, 1);
    assert.ok(after.lastRunAt && after.nextRunAt! > Date.now());
    await t!.waitFor(() => t!.feed(a.id).some((i) => i.kind === 'text' && i.text.includes('Post the standup summary')), 3000);

    makeDue(t!, watch.id);
    await t!.waitFor(() => scheduled(t!, a.id).length === 2);
    assert.match(scheduled(t!, a.id)[1].text, /run 2\]/);
    assert.ok(t!.events.some((e) => e.type === 'watch:upsert' && e.watch.id === watch.id && e.watch.runs === 2));
  });

  it('a run missed while the node was down fires once, marked late', async () => {
    const a = await agent();
    const { watch } = t!.node.watches.create({ agentId: a.id, cron: '@hourly', message: 'check the queue' });
    await t!.node.stop();
    // simulate downtime: the 10-minutes-ago run was missed
    const { Store } = await import('../src/store/db.ts');
    const s = new Store(t!.home);
    s.db.prepare('UPDATE watches SET next_run_at = ? WHERE id = ?').run(Date.now() - 10 * 60_000, watch.id);
    s.close();
    const { Node } = await import('../src/node.ts');
    t!.node = new Node({ home: t!.home, port: 0, claudeBin: (t!.node.cfg as any).claudeBin, idleReapMs: 60_000 }, {}, undefined, { watches: { cronTickMs: 50 } });
    await t!.node.start();
    const msg = await t!.waitFor(() => scheduled(t!, a.id)[0]);
    assert.match(msg.text, /run 1; was due .*, the node was down\]/);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(scheduled(t!, a.id).length, 1, 'only once');
    assert.ok(t!.node.watches.get(watch.id).nextRunAt! > Date.now());
  });

  it('validates input, has its own limit, and is cancelled with the agent', async () => {
    const a = await agent();
    assert.throws(() => t!.node.watches.create({ agentId: a.id, cron: '0 9 * * *' }), /needs a --message/);
    assert.throws(() => t!.node.watches.create({ agentId: a.id, cron: 'whenever', message: 'x' }), /not a schedule/);
    assert.throws(() => t!.node.watches.create({ agentId: a.id, cron: '@daily', message: 'x', command: 'ls' }), /takes no command/);
    for (let i = 0; i < 5; i++) t!.node.watches.create({ agentId: a.id, cron: '@daily', message: `m${i}` });
    // schedules don't use up the 5 job slots
    const job = t!.node.watches.create({ agentId: a.id, command: 'sleep 30' });
    assert.equal(job.watch.status, 'active');
    for (let i = 5; i < 10; i++) t!.node.watches.create({ agentId: a.id, cron: '@daily', message: `m${i}` });
    assert.throws(() => t!.node.watches.create({ agentId: a.id, cron: '@daily', message: 'one too many' }), /already has 10 schedules/);

    const one = t!.node.watches.list({ agentId: a.id }).find((w) => w.mode === 'cron')!;
    assert.equal(t!.node.watches.cancel(one.id).status, 'cancelled');
    makeDue(t!, one.id);
    await t!.node.runtime.remove(a.id);
    assert.ok(t!.node.watches.list({ agentId: a.id }).every((w) => w.status !== 'active'));
  });

  it('agents set schedules with the CLI', async () => {
    const a = await agent();
    const env = { PATH: process.env.PATH, AXO_NODE_URL: `http://127.0.0.1:${t!.node.cfg.port}`, AXO_TOKEN: agentToken(t!.node.cfg.token, a.id), AXO_AGENT_ID: a.id };
    const run = (...args: string[]) => new Promise<string>((resolve) => {
      const c = spawn('sh', [t!.node.bin.axo, ...args], { env });
      let out = '';
      c.stdout.on('data', (d) => { out += d; });
      c.stderr.on('data', (d) => { out += d; });
      c.on('close', () => resolve(out));
    });
    assert.match(await run('watch', '--cron', '0 9 * * 1-5', '--message', 'standup time'), /Schedule \w+ set \(0 9 \* \* 1-5\)\. Next message: /);
    assert.match(await run('watch', '--every', '2h', '--message', 'stretch'), /set \(@every 2h\)/);
    const ls = await run('watch', 'ls');
    assert.match(ls, /every 0 9 \* \* 1-5: standup time {2}\(0 run\(s\), next /);
    assert.match(await run('watch', '--cron', 'nope', '--message', 'x'), /not a schedule/);
    const list = await call(t!, '/watches', {}, env.AXO_TOKEN);
    assert.equal(list.body.filter((w: any) => w.mode === 'cron').length, 2);
  });
});

describe('team goal', () => {
  it('writes the goal to the team brief the journalist reads, updates and renames it', async () => {
    t = await makeNode();
    initRepo(t.project);
    const p = t.node.projects.create(t.project);
    const res = await call(t, '/teams', { method: 'POST', body: JSON.stringify({ projectId: p.id, name: 'billing', goal: 'Ship Stripe checkout with webhooks and tests.' }) });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const file = join(t.project, '.axo', 'context', 'teams', 'billing.md');
    const brief = readFileSync(file, 'utf8');
    assert.match(brief, /^# Team billing\n\n## Goal\nShip Stripe checkout with webhooks and tests\.\n/);
    assert.match(brief, /## Where\nBranch `axo\/billing`/);

    // Agents in the team get it in their system prompt via the journalist's context.
    const a = t.node.runtime.create({ projectId: p.id, teamId: res.body.id, name: 'payer', task: 'hi' });
    await t.waitFor(() => t!.node.runtime.get(a.id).status === 'idle');
    const args = t.spawns().filter((s) => s.args.includes('--input-format')).at(-1)!.args;
    assert.match(args[args.indexOf('--append-system-prompt') + 1], /Ship Stripe checkout with webhooks/);

    // Update replaces only the goal section.
    await call(t, `/teams/${res.body.id}`, { method: 'PATCH', body: JSON.stringify({ goal: 'Ship checkout; refunds next.' }) });
    const updated = readFileSync(file, 'utf8');
    assert.match(updated, /## Goal\nShip checkout; refunds next\.\n/);
    assert.doesNotMatch(updated, /webhooks/);
    assert.match(updated, /## Where/);

    // Rename moves the brief with the team.
    await call(t, `/teams/${res.body.id}`, { method: 'PATCH', body: JSON.stringify({ name: 'payments' }) });
    assert.ok(!existsSync(file));
    const moved = (await call(t, `/teams/${res.body.id}/brief`)).body.text;
    assert.match(moved, /^# Team payments\n/);
    assert.match(moved, /refunds next/);
  });

  it('is optional, and works for non-git (direct) teams', async () => {
    t = await makeNode();
    const p = t.node.projects.create(t.project);
    const plain = t.node.teams.create({ projectId: p.id, name: 'nogoal' });
    assert.equal(t.node.teams.brief(plain.id), '');
    const d = t.node.teams.create({ projectId: p.id, name: 'ops', goal: 'Keep prod green.' });
    assert.match(t.node.teams.brief(d.id), /^# Team ops\n\n## Goal\nKeep prod green\.\n$/);
  });
});
