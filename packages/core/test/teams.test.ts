import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeNode, initRepo, call, type TestNode } from './helpers.ts';

let t: TestNode;
afterEach(async () => { await t?.stop(); });

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

describe('teams and worktrees', () => {
  it('creates a worktree team on axo/<slug>, excludes .axo/ via .git/info/exclude, never touches .gitignore', async () => {
    t = await makeNode();
    initRepo(t.project);
    const p = t.node.projects.create(t.project);
    const res = await call(t, '/teams', { method: 'POST', body: JSON.stringify({ projectId: p.id, name: 'Core Team' }) });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const team = res.body;
    assert.equal(team.mode, 'worktree');
    assert.equal(team.branch, 'axo/core-team');
    assert.equal(team.worktreePath, join(t.project, '.axo', 'worktrees', 'core-team'));
    assert.ok(existsSync(join(team.worktreePath, 'README.md')));
    assert.equal(git(team.worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD'), 'axo/core-team');
    assert.match(readFileSync(join(t.project, '.git', 'info', 'exclude'), 'utf8'), /^\.axo\/$/m);
    assert.equal(readFileSync(join(t.project, '.gitignore'), 'utf8'), 'node_modules/\n');
    assert.equal(git(t.project, 'status', '--porcelain'), '', 'main checkout stays clean');
    assert.ok(t.events.some((e) => e.type === 'team:upsert' && e.team.id === team.id));

    // A second team with the same slug gets a fresh branch; the exclude line is not duplicated.
    const dup = await call(t, '/teams', { method: 'POST', body: JSON.stringify({ projectId: p.id, name: 'core team' }) });
    assert.equal(dup.status, 409);
    const t2 = (await call(t, '/teams', { method: 'POST', body: JSON.stringify({ projectId: p.id, name: 'core.team' }) })).body;
    assert.equal(t2.branch, 'axo/core-team-2');
    assert.equal(readFileSync(join(t.project, '.git', 'info', 'exclude'), 'utf8').match(/^\.axo\/$/gm)!.length, 1);
  });

  it('runs agents in the team worktree', async () => {
    t = await makeNode();
    initRepo(t.project);
    const p = t.node.projects.create(t.project);
    const team = t.node.teams.create({ projectId: p.id, name: 'api' });
    const a = t.node.runtime.create({ projectId: p.id, teamId: team.id, name: 'backend-1', task: 'hi' });
    assert.equal(a.workdir, team.worktreePath);
    await t.waitFor(() => t.node.runtime.get(a.id).status === 'idle');
    assert.equal(realpathSync(t.spawns()[0].cwd), realpathSync(team.worktreePath!));
  });

  it('supports shared and direct modes and rejects worktree mode outside git', async () => {
    t = await makeNode();
    const p = t.node.projects.create(t.project); // not a git repo
    assert.throws(() => t.node.teams.create({ projectId: p.id, name: 'x', mode: 'worktree' }), /needs a git project/);
    const d = t.node.teams.create({ projectId: p.id, name: 'ops' });
    assert.equal(d.mode, 'direct');
    assert.equal(d.worktreePath, null);
    const a = t.node.runtime.create({ projectId: p.id, teamId: d.id });
    assert.equal(a.workdir, t.project);
  });

  it('renames without moving the worktree, and archives (stopping agents, keeping the branch)', async () => {
    t = await makeNode();
    initRepo(t.project);
    const p = t.node.projects.create(t.project);
    const team = t.node.teams.create({ projectId: p.id, name: 'ui' });
    const renamed = (await call(t, `/teams/${team.id}`, { method: 'PATCH', body: JSON.stringify({ name: 'frontend' }) })).body;
    assert.equal(renamed.name, 'frontend');
    assert.equal(renamed.worktreePath, team.worktreePath);

    const a = t.node.runtime.create({ projectId: p.id, teamId: team.id, task: 'hello' });
    await t.waitFor(() => t.node.runtime.get(a.id).status === 'idle');

    writeFileSync(join(team.worktreePath!, 'wip.txt'), 'uncommitted');
    const dirty = await call(t, `/teams/${team.id}/archive`, { method: 'POST', body: JSON.stringify({ removeWorktree: true }) });
    assert.equal(dirty.status, 409);
    assert.match(dirty.body.error, /uncommitted/);
    assert.ok(existsSync(team.worktreePath!));

    git(team.worktreePath!, 'add', '.');
    git(team.worktreePath!, 'commit', '-q', '-m', 'wip');
    const ok = await call(t, `/teams/${team.id}/archive`, { method: 'POST', body: JSON.stringify({ removeWorktree: true }) });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.ok(ok.body.archivedAt);
    assert.ok(!existsSync(team.worktreePath!));
    assert.equal(git(t.project, 'rev-parse', '--verify', 'axo/ui'), git(t.project, 'rev-parse', 'axo/ui'), 'branch kept');
    assert.equal(t.node.runtime.get(a.id).status, 'stopped');

    const spawn = await call(t, '/agents', { method: 'POST', body: JSON.stringify({ projectId: p.id, teamId: team.id }) });
    assert.equal(spawn.status, 400);
  });

  it('runs the project setup command as a team watch when the worktree is created', async () => {
    t = await makeNode();
    initRepo(t.project);
    const p = t.node.projects.create(t.project);
    const upd = await call(t, `/projects/${p.id}`, { method: 'PATCH', body: JSON.stringify({ setupCmd: 'echo installed > setup.out' }) });
    assert.equal(upd.body.setupCmd, 'echo installed > setup.out');
    const team = t.node.teams.create({ projectId: p.id, name: 'setup' });
    const w = await t.waitFor(() => t.node.watches.list({ teamId: team.id }).find((x) => x.status === 'delivered'));
    assert.equal(w.result?.exitCode, 0);
    assert.equal(readFileSync(join(team.worktreePath!, 'setup.out'), 'utf8').trim(), 'installed');
    assert.equal(w.agentId, null);
  });
});
