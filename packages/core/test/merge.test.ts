import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeNode, initRepo, call, type TestNode } from './helpers.ts';

let t: TestNode;
afterEach(async () => { await t?.stop(); });

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
function commitFile(cwd: string, file: string, content: string, msg: string) {
  writeFileSync(join(cwd, file), content);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-q', '-m', msg);
}
async function setup() {
  t = await makeNode();
  initRepo(t.project);
  const p = t.node.projects.create(t.project);
  const team = t.node.teams.create({ projectId: p.id, name: 'api' });
  return { p, team, wt: team.worktreePath! };
}

describe('team diff and merge', () => {
  it('diffs the team branch against base: commits, numstat, patch, dirty files', async () => {
    const { team, wt } = await setup();
    commitFile(wt, 'server.ts', 'export const port = 3000;\n', 'add server');
    writeFileSync(join(wt, 'scratch.txt'), 'wip');
    const res = await call(t, `/teams/${team.id}/diff`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const d = res.body;
    assert.equal(d.base, 'main');
    assert.equal(d.branch, 'axo/api');
    assert.equal(d.ahead, 1);
    assert.equal(d.behind, 0);
    assert.deepEqual(d.commits.map((c: any) => c.subject), ['add server']);
    assert.deepEqual(d.files, [{ path: 'server.ts', additions: 1, deletions: 0, binary: false }]);
    assert.match(d.patch, /\+export const port = 3000;/);
    assert.equal(d.truncated, false);
    assert.deepEqual(d.dirty, ['?? scratch.txt']);
  });

  it('merges into the checked-out base, refusing a dirty worktree and empty merges', async () => {
    const { team, wt } = await setup();
    commitFile(wt, 'server.ts', 'x\n', 'add server');
    writeFileSync(join(wt, 'forgot.ts'), 'not committed');
    const dirty = await call(t, `/teams/${team.id}/merge`, { method: 'POST', body: '{}' });
    assert.equal(dirty.status, 409);
    assert.match(dirty.body.error, /uncommitted changes[\s\S]*forgot\.ts/);

    git(wt, 'add', '.');
    git(wt, 'commit', '-q', '-m', 'add forgot');
    const ok = await call(t, `/teams/${team.id}/merge`, { method: 'POST', body: JSON.stringify({ strategy: 'merge' }) });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.strategy, 'merge');
    assert.equal(git(t.project, 'rev-parse', 'HEAD'), ok.body.commit);
    assert.equal(git(t.project, 'rev-list', '--parents', '-n1', 'HEAD').split(' ').length, 3, 'a real merge commit');
    assert.ok(existsSync(join(t.project, 'server.ts')), 'main checkout updated');
    assert.equal(git(t.project, 'status', '--porcelain'), '');
    assert.ok(t.events.some((e) => e.type === 'team:merged' && e.teamId === team.id && e.commit === ok.body.commit));

    const again = await call(t, `/teams/${team.id}/merge`, { method: 'POST', body: '{}' });
    assert.equal(again.status, 409);
    assert.match(again.body.error, /nothing to merge/);
  });

  it('squash-merges into a single-parent commit listing the branch commits', async () => {
    const { team, wt } = await setup();
    commitFile(wt, 'a.ts', 'a\n', 'add a');
    commitFile(wt, 'b.ts', 'b\n', 'add b');
    const res = t.node.teams.merge(team.id, 'squash');
    assert.equal(git(t.project, 'rev-list', '--parents', '-n1', 'HEAD').split(' ').length, 2);
    assert.match(git(t.project, 'log', '-1', '--format=%B'), /team api \(squash of axo\/api\)[\s\S]*- add a[\s\S]*- add b/);
    assert.equal(res.commit, git(t.project, 'rev-parse', 'HEAD'));
  });

  it('refuses conflicts and leaves the base checkout untouched', async () => {
    const { team, wt } = await setup();
    commitFile(wt, 'README.md', '# team version\n', 'team readme');
    commitFile(t.project, 'README.md', '# main version\n', 'main readme');
    const head = git(t.project, 'rev-parse', 'HEAD');
    for (const strategy of ['merge', 'squash']) {
      const res = await call(t, `/teams/${team.id}/merge`, { method: 'POST', body: JSON.stringify({ strategy }) });
      assert.equal(res.status, 409);
      assert.match(res.body.error, /conflicts in:\nREADME\.md[\s\S]*Nothing was changed/);
      assert.equal(git(t.project, 'rev-parse', 'HEAD'), head);
      assert.equal(git(t.project, 'status', '--porcelain'), '');
      assert.equal(readFileSync(join(t.project, 'README.md'), 'utf8'), '# main version\n');
    }
  });

  it('refuses when the base checkout has uncommitted tracked changes', async () => {
    const { team, wt } = await setup();
    commitFile(wt, 'x.ts', 'x\n', 'x');
    writeFileSync(join(t.project, 'README.md'), 'edited on main\n');
    const res = await call(t, `/teams/${team.id}/merge`, { method: 'POST', body: '{}' });
    assert.equal(res.status, 409);
    assert.match(res.body.error, /main is checked out at .* with uncommitted changes[\s\S]*README\.md/);
  });

  it('merges without a checkout of base (plumbing), and still detects conflicts', async () => {
    const { team, wt } = await setup();
    git(t.project, 'checkout', '-q', '-b', 'other'); // nobody has main checked out now
    commitFile(wt, 'feature.ts', 'f\n', 'feature');
    const before = git(t.project, 'rev-parse', 'main');
    const res = t.node.teams.merge(team.id, 'merge');
    assert.equal(git(t.project, 'rev-parse', 'main'), res.commit);
    assert.equal(git(t.project, 'rev-parse', `${res.commit}^1`), before);
    assert.equal(git(t.project, 'show', 'main:feature.ts'), 'f');
    assert.equal(git(t.project, 'rev-parse', '--abbrev-ref', 'HEAD'), 'other', 'checkout untouched');

    commitFile(wt, 'README.md', 'team\n', 'team readme');
    git(t.project, 'checkout', '-q', 'main');
    commitFile(t.project, 'README.md', 'main\n', 'main readme');
    git(t.project, 'checkout', '-q', 'other');
    assert.throws(() => t.node.teams.merge(team.id, 'merge'), /conflicts in:\nREADME\.md/);
  });

  it('rejects merge/diff for shared-mode teams and bad strategies', async () => {
    const { p, team } = await setup();
    const shared = t.node.teams.create({ projectId: p.id, name: 'live', mode: 'shared' });
    assert.equal((await call(t, `/teams/${shared.id}/diff`)).status, 400);
    assert.equal((await call(t, `/teams/${team.id}/merge`, { method: 'POST', body: '{"strategy":"rebase"}' })).status, 400);
  });
});

describe('per-agent worktrees', () => {
  it('creates the agent in its own worktree off the team branch, then merges it into the team', async () => {
    const { p, team, wt } = await setup();
    commitFile(wt, 'team.ts', 'team\n', 'team work');
    const res = await call(t, '/agents', { method: 'POST', body: JSON.stringify({ projectId: p.id, teamId: team.id, name: 'risky', ownWorktree: true, task: 'hi' }) });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const agent = res.body;
    assert.equal(agent.workdir, join(t.project, '.axo', 'worktrees', 'api--risky'));
    assert.equal(git(agent.workdir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'axo/api--risky');
    assert.ok(existsSync(join(agent.workdir, 'team.ts')), 'branched from the team branch, not main');
    await t.waitFor(() => t.node.runtime.get(agent.id).status === 'idle');
    assert.equal(realpathSync(t.spawns()[0].cwd), realpathSync(agent.workdir), 'first spawn already in its worktree');

    commitFile(agent.workdir, 'experiment.ts', 'e\n', 'experiment');
    const d = (await call(t, `/agents/${agent.id}/diff`)).body;
    assert.equal(d.base, 'axo/api');
    assert.equal(d.branch, 'axo/api--risky');
    assert.deepEqual(d.files.map((f: any) => f.path), ['experiment.ts']);

    const m = await call(t, `/agents/${agent.id}/merge-into-team`, { method: 'POST', body: '{"strategy":"squash"}' });
    assert.equal(m.status, 200, JSON.stringify(m.body));
    assert.equal(m.body.base, 'axo/api');
    assert.ok(existsSync(join(wt, 'experiment.ts')), 'team worktree updated');
    assert.equal(git(wt, 'rev-parse', 'HEAD'), m.body.commit);
    assert.ok(t.events.some((e) => e.type === 'team:merged' && e.agentId === agent.id));

    // A normal team member has no branch of its own.
    const plain = t.node.runtime.create({ projectId: p.id, teamId: team.id, name: 'plain' });
    assert.equal((await call(t, `/agents/${plain.id}/merge-into-team`, { method: 'POST', body: '{}' })).status, 400);
  });

  it('cannot move an agent that has already run', async () => {
    const { p, team } = await setup();
    const a = t.node.runtime.create({ projectId: p.id, teamId: team.id, task: 'hi' });
    await t.waitFor(() => t.node.runtime.get(a.id).status === 'idle');
    assert.throws(() => t.node.runtime.setWorkdir(a.id, t.project), /before the agent first runs/);
  });
});
