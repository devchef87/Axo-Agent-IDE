import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Agent } from '@axo/protocol';
import { makeNode, call, initRepo, type TestNode } from './helpers.ts';
import { decide, globToRegExp, relativeInside, toolPaths } from '../src/teams/scope.ts';
import { agentToken, verifyAgentToken } from '../src/util/agent-token.ts';

let current: TestNode | undefined;

/** Run the hook asynchronously (spawnSync would block the in-process node it calls). */
function runHook(knock: string, input: object, env: NodeJS.ProcessEnv): Promise<{ status: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('sh', [knock], { env });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}
afterEach(async () => { await current?.stop(); current = undefined; });

const agent = (name: string, workdir: string, scopeGlobs: string[] = []): Agent => ({
  id: name, name, projectId: 'p', teamId: 't', role: 'dev', model: 'opus', effort: null, scopeGlobs, instructions: '',
  workdir, status: 'idle', sessionId: null, generation: 0, queued: 0, contextTokens: 0, contextWindow: 0, sessionTokens: 0,
  compactions: 0, lastError: null, createdAt: 0, lastActiveAt: 0,
});

describe('scope globs and paths', () => {
  it('matches globs', () => {
    const m = (g: string, p: string) => globToRegExp(g).test(p);
    assert.ok(m('src/api/**', 'src/api/x.ts'));
    assert.ok(m('src/api/**', 'src/api/deep/x.ts'));
    assert.ok(!m('src/api/**', 'src/apix/x.ts'));
    assert.ok(m('src/api', 'src/api/x.ts'), 'bare dir = dir/**');
    assert.ok(m('src/api', 'src/api'));
    assert.ok(m('src/', 'src/a/b'));
    assert.ok(m('**/*.test.ts', 'a/b/c.test.ts'));
    assert.ok(m('**/*.test.ts', 'c.test.ts'));
    assert.ok(m('*.md', 'README.md'));
    assert.ok(!m('*.md', 'docs/README.md'));
    assert.ok(m('packages/{ui,app}/**', 'packages/app/src/main.ts'));
    assert.ok(!m('packages/{ui,app}/**', 'packages/core/x.ts'));
    assert.ok(m('./src/**', 'src/a.ts'));
    assert.ok(m('a?.ts', 'ab.ts'));
  });

  it('resolves paths relative to the workdir through symlinks (macOS /var → /private/var)', () => {
    const root = mkdtempSync(join(tmpdir(), 'axo-scope-'));
    mkdirSync(join(root, 'real', 'src'), { recursive: true });
    symlinkSync(join(root, 'real'), join(root, 'link'));
    assert.equal(relativeInside(join(root, 'link'), join(realpathSync(root), 'real', 'src', 'new', 'file.ts')), 'src/new/file.ts');
    assert.equal(relativeInside(join(root, 'real'), join(root, 'link', 'src', 'a.ts')), 'src/a.ts');
    assert.equal(relativeInside(join(root, 'real'), join(root, 'elsewhere.ts')), null);
  });

  it('extracts target paths from write tools', () => {
    assert.deepEqual(toolPaths({ file_path: '/a/b.ts', content: 'x' }), ['/a/b.ts']);
    assert.deepEqual(toolPaths({ notebook_path: 'n.ipynb' }), ['n.ipynb']);
    assert.deepEqual(toolPaths({ file_path: 'a', edits: [{ file_path: 'a' }, { file_path: 'b' }] }), ['a', 'b']);
  });

  it('decides: own scope, teammate scope, overlap, outside the workdir', () => {
    const wd = mkdtempSync(join(tmpdir(), 'axo-wd-'));
    const be = agent('backend-1', wd, ['src/api/**']);
    const ui = agent('ui-1', wd, ['src/ui/**']);
    const free = agent('free', wd);
    // own scope
    assert.equal(decide(be, [ui], [join(wd, 'src/api/x.ts')]).allow, true);
    const out = decide(be, [ui], [join(wd, 'README.md')]);
    assert.equal(out.allow, false);
    assert.match(out.reason!, /README\.md is outside your scope \(src\/api\/\*\*\)/);
    // teammate's scope
    const owned = decide(free, [be, ui], ['src/api/routes.ts']);
    assert.equal(owned.allow, false);
    assert.equal(owned.owner, 'backend-1');
    assert.match(owned.reason!, /src\/api\/routes\.ts is owned by backend-1 \(scope src\/api\/\*\*\).*axo ask backend-1/);
    // outside own scope and inside a teammate's: names the owner
    assert.match(decide(be, [ui], [join(wd, 'src/ui/a.tsx')]).reason!, /belongs to ui-1/);
    // unowned paths and paths outside the workdir are fine
    assert.equal(decide(free, [be, ui], ['docs/x.md']).allow, true);
    assert.equal(decide(be, [ui], ['/tmp/scratch.txt']).allow, true);
    // overlap: if it's in my scope too, I may write it
    const both = agent('both', wd, ['src/**']);
    assert.equal(decide(both, [be], ['src/api/x.ts']).allow, true);
    // a shared-checkout scope does not reach into team worktrees under .axo/
    const main = agent('main-1', wd, ['**']);
    const wt = agent('wt', join(wd, '.axo', 'worktrees', 'x'));
    assert.equal(decide(wt, [main], [join(wd, '.axo', 'worktrees', 'x', 'src', 'a.ts')]).allow, true);
  });

  it('agent tokens verify and cannot be forged', () => {
    const tok = agentToken('node-secret', '01abc');
    assert.equal(verifyAgentToken('node-secret', tok), '01abc');
    assert.equal(verifyAgentToken('other-secret', tok), null);
    assert.equal(verifyAgentToken('node-secret', tok.replace('01abc', '01abd')), null);
    assert.equal(verifyAgentToken('node-secret', 'garbage'), null);
  });
});

describe('knock hook', () => {
  it('injects the hook, PATH and a per-agent token into every claude spawn', async () => {
    const t = current = await makeNode();
    const p = t.node.projects.create(t.project);
    const a = t.node.runtime.create({ projectId: p.id, task: 'hi' });
    await t.waitFor(() => t.node.runtime.get(a.id).status === 'idle');
    const s = t.spawns()[0];
    const settings = JSON.parse(s.args[s.args.indexOf('--settings') + 1]);
    const hook = settings.hooks.PreToolUse[0];
    assert.equal(hook.matcher, 'Write|Edit|MultiEdit|NotebookEdit');
    assert.match(hook.hooks[0].command, /knock\.sh/);
    assert.ok(s.env.PATH.startsWith(join(t.home, 'bin') + ':'));
    assert.equal(verifyAgentToken(t.node.cfg.token, s.env.AXO_TOKEN), a.id);
    assert.notEqual(s.env.AXO_TOKEN, t.node.cfg.token);
  });

  it('agent tokens only reach agent routes', async () => {
    const t = current = await makeNode();
    const p = t.node.projects.create(t.project);
    const a = t.node.runtime.create({ projectId: p.id });
    const b = t.node.runtime.create({ projectId: p.id });
    const tok = agentToken(t.node.cfg.token, a.id);
    assert.equal((await call(t, '/state', {}, tok)).status, 401);
    assert.equal((await call(t, `/agents/${a.id}/message`, { method: 'POST', body: '{"text":"x"}' }, tok)).status, 401);
    assert.equal((await call(t, '/innerchat/who', {}, tok)).status, 200);
    assert.equal((await call(t, `/agents/${b.id}/refresh`, { method: 'POST', body: '{}' }, tok)).status, 401, 'cannot rotate others');
    const me = await call(t, '/me', {}, tok);
    assert.equal(me.body.agent.id, a.id);
  });

  it('the curl hook denies a teammate-owned write with exit 2 and the reason on stderr', async () => {
    const t = current = await makeNode();
    initRepo(t.project);
    const p = t.node.projects.create(t.project);
    const team = t.node.teams.create({ projectId: p.id, name: 'core' });
    const owner = t.node.runtime.create({ projectId: p.id, teamId: team.id, name: 'backend-1' });
    t.node.runtime.update(owner.id, { scopeGlobs: ['src/api/**'] });
    const me = t.node.runtime.create({ projectId: p.id, teamId: team.id, name: 'ui-1' });
    const env = {
      PATH: process.env.PATH, AXO_NODE_URL: `http://127.0.0.1:${t.node.cfg.port}`,
      AXO_TOKEN: agentToken(t.node.cfg.token, me.id), AXO_AGENT_ID: me.id,
    };
    const run = (input: object) => runHook(t.node.bin.knock, input, env);

    // Claude reports realpaths (/private/var/... on macOS); the workdir may be stored as /var/...
    const target = join(realpathSync(team.worktreePath!), 'src', 'api', 'routes.ts');
    const denied = await run({ tool_name: 'Write', tool_input: { file_path: target, content: 'x' }, cwd: team.worktreePath });
    assert.equal(denied.status, 2);
    assert.match(denied.stderr, /src\/api\/routes\.ts is owned by backend-1/);
    assert.match(denied.stderr, /axo ask backend-1/);
    assert.ok(t.events.some((e) => e.type === 'knock:denied' && e.agentId === me.id && e.owner === 'backend-1'));

    const allowed = await run({ tool_name: 'Edit', tool_input: { file_path: join(team.worktreePath!, 'src', 'ui', 'App.tsx') } });
    assert.equal(allowed.status, 0);
    assert.equal(allowed.stderr, '');

    // The owner itself may write there.
    const own = await runHook(t.node.bin.knock, { tool_name: 'Write', tool_input: { file_path: target } },
      { ...env, AXO_TOKEN: agentToken(t.node.cfg.token, owner.id) });
    assert.equal(own.status, 0);
  });

  it('fails open and logs when the node is unreachable', async () => {
    const t = current = await makeNode();
    const knock = t.node.bin.knock;
    const res = await runHook(knock, { tool_name: 'Write', tool_input: { file_path: '/x' } },
      { PATH: process.env.PATH, AXO_NODE_URL: 'http://127.0.0.1:9', AXO_TOKEN: 'axa.x.y', AXO_AGENT_ID: 'agent-x' });
    assert.equal(res.status, 0);
    assert.match(readFileSync(join(t.home, 'logs', 'knock.log'), 'utf8'), /agent-x fail-open/);
  });
});
