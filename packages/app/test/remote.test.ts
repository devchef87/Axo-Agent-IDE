import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, chmodSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { ServersSnapshot, VersionInfo } from '@axo/protocol';
import { parseSshConfig, validateTarget, sshExec } from '../src/ssh.ts';
import { nodeSupport, systemdUnit, evaluatePreflight, parseKv } from '../src/remote.ts';
import { NodeManager, freePort, type NodeConn } from '../src/node-manager.ts';

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_SSH = join(here, 'fixtures', 'fake-ssh.mjs');
const CORE = join(here, '..', '..', 'core');
const BUNDLE = join(CORE, 'dist', 'axo-node.mjs');

const until = async (fn: () => boolean | Promise<boolean>, ms = 15_000, what = 'condition') => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await new Promise((r) => setTimeout(r, 50)); }
  throw new Error(`timed out waiting for ${what}`);
};

describe('ssh config import', () => {
  test('parses hosts, skips wildcards, follows Include, first value wins', () => {
    const dir = mkdtempSync(join(tmpdir(), 'axo-sshcfg-'));
    writeFileSync(join(dir, 'extra'), 'Host staging\n  HostName 10.0.0.2\n  User deploy\n');
    writeFileSync(join(dir, 'config'), [
      `Include ${join(dir, 'extra')}`,
      'Host *',
      '  ServerAliveInterval 30',
      'Host prod-1 prod-alias',
      '  HostName=prod.example.com',
      '  User ubuntu',
      '  User ignored',
      '  Port 2222',
      '  IdentityFile ~/.ssh/prod',
      'Match host foo',
      '  User nope',
      'Host !bad *.internal',
    ].join('\n'));
    const hosts = parseSshConfig(join(dir, 'config'));
    assert.deepEqual(hosts.map((h) => h.alias), ['staging', 'prod-1', 'prod-alias']);
    assert.deepEqual(hosts[1], { alias: 'prod-1', hostName: 'prod.example.com', user: 'ubuntu', port: 2222, identityFile: '~/.ssh/prod' });
    assert.equal(hosts[0].user, 'deploy');
  });

  test('rejects targets ssh could parse as options', () => {
    assert.throws(() => validateTarget({ host: '-oProxyCommand=touch /tmp/x' }));
    assert.throws(() => validateTarget({ host: 'a b' }));
    assert.throws(() => validateTarget({ host: 'ok', user: '-l' }));
    assert.throws(() => validateTarget({ host: 'ok', port: 70000 }));
    validateTarget({ host: 'user@prod-1.example.com', port: 22 });
  });
});

describe('preflight evaluation', () => {
  test('node:sqlite support by version', () => {
    assert.equal(nodeSupport('v22.13.0').status, 'pass');
    assert.equal(nodeSupport('v24.1.0').status, 'pass');
    assert.equal(nodeSupport('v23.4.0').status, 'pass');
    assert.deepEqual(nodeSupport('v22.5.1').flags, ['--experimental-sqlite']);
    assert.deepEqual(nodeSupport('v23.1.0').flags, ['--experimental-sqlite']);
    assert.equal(nodeSupport('v22.4.0').status, 'fail');
    assert.equal(nodeSupport('v20.11.0').status, 'fail');
  });

  test('turns probe output into pass/warn/fail rows', () => {
    const kv = parseKv([
      'os=Linux', 'distro=Ubuntu 24.04 LTS', 'arch=x86_64', 'path=/usr/bin', 'node=/usr/bin/node', 'node_version=v22.6.0',
      'claude=/usr/bin/claude', 'claude_version=2.1.280 (Claude Code)', 'claude_auth="loggedIn": false ',
      'git=', 'disk_kb=2097152', 'systemd=1', 'linger=no', 'groove=1', 'junk line',
    ].join('\n'));
    const r = evaluatePreflight(kv, 31500);
    const by = Object.fromEntries(r.checks.map((c) => [c.id, c.status]));
    assert.deepEqual(by, { os: 'pass', node: 'warn', claude: 'pass', auth: 'fail', git: 'warn', disk: 'warn', service: 'warn', port: 'pass', groove: 'pass' });
    assert.equal(r.ok, false);
    assert.deepEqual(r.nodeFlags, ['--experimental-sqlite']);
    assert.equal(r.systemd, true);
    assert.equal(r.linger, false);
  });

  test('port held by something else fails', () => {
    const r = evaluatePreflight(parseKv('os=Linux\nport_in_use=1'), 31500);
    assert.equal(r.checks.find((c) => c.id === 'port')!.status, 'fail');
  });

  test('systemd unit escapes % and quotes paths', () => {
    const u = systemdUnit({ nodePath: '/opt/my node/bin/node', nodeFlags: ['--experimental-sqlite'], pathEnv: '/a%b:/usr/bin', remotePort: 31500 });
    assert.match(u, /Environment="PATH=\/a%%b:\/usr\/bin"/);
    assert.match(u, /ExecStart="\/opt\/my node\/bin\/node" "--experimental-sqlite" "--disable-warning=ExperimentalWarning" %h\/\.axo\/bin\/axo-node\.mjs --port 31500/);
    assert.match(u, /KillMode=mixed/);
  });
});

describe('server lifecycle over (fake) ssh', () => {
  let root: string;
  let remoteHome: string;
  let mgr: NodeManager;
  let remotePort: number;
  const sshEnv = () => ({ sshBin: FAKE_SSH, controlDir: join(root, 'ctl') });
  const bundleInfo = () => JSON.parse(readFileSync(join(CORE, 'dist', 'axo-node.json'), 'utf8')) as { version: string; build: string };
  let lastConns: NodeConn[] = [];
  let lastSnap: ServersSnapshot | null = null;

  before(async () => {
    execFileSync(process.execPath, ['build.mjs'], { cwd: CORE, stdio: 'ignore' });
    root = mkdtempSync(join(tmpdir(), 'axo-remote-'));
    remoteHome = join(root, 'remote-home');
    mkdirSync(remoteHome);
    // Fake "server" tools: a logged-in claude, and a systemctl that fails (forces the nohup path, also on Linux CI).
    const bin = join(root, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'claude'), `#!/bin/sh\nif [ "$1" = auth ]; then printf '{\\n  "loggedIn": true,\\n  "authMethod": "claude.ai",\\n  "email": "x@y"\\n}\\n'; else echo "2.1.280 (Claude Code)"; fi\n`);
    writeFileSync(join(bin, 'systemctl'), '#!/bin/sh\nexit 1\n');
    chmodSync(join(bin, 'claude'), 0o755);
    chmodSync(join(bin, 'systemctl'), 0o755);
    process.env.PATH = `${bin}:${process.env.PATH}`;
    process.env.FAKE_REMOTE_HOME = remoteHome;
    process.env.FAKE_SSH_LOG = join(root, 'ssh.log');
    remotePort = await freePort();
    mgr = new NodeManager({ dataDir: join(root, 'data'), sshEnv: sshEnv(), readBundle: () => readFileSync(BUNDLE), bundleInfo: bundleInfo(), idlePollMs: 50, lostAfterMs: 400 });
    mgr.on('nodes', (c: NodeConn[]) => { lastConns = c; });
    mgr.on('snapshot', (s: ServersSnapshot) => { lastSnap = s; });
  });

  after(async () => {
    await mgr?.shutdown();
    // Never leak the test node.
    if (remoteHome && existsSync(join(remoteHome, '.axo/bin/stop.sh'))) execFileSync('sh', [join(remoteHome, '.axo/bin/stop.sh')], { env: { ...process.env, HOME: remoteHome } });
    rmSync(root, { recursive: true, force: true });
  });

  test('sshExec passes multiplexing options and a stdin script', async () => {
    const r = await sshExec(sshEnv(), { host: 'box', user: 'ubuntu', port: 2200 }, 'echo "hi $HOME"');
    assert.equal(r.code, 0);
    assert.equal(r.stdout.trim(), `hi ${remoteHome}`);
    const args = JSON.parse(readFileSync(process.env.FAKE_SSH_LOG!, 'utf8').trim().split('\n').pop()!) as string[];
    for (const o of ['BatchMode=yes', 'ControlMaster=auto', 'ControlPersist=120', 'User=ubuntu', 'Port=2200', 'ServerAliveInterval=15']) assert.ok(args.includes(o), o);
    assert.deepEqual(args.slice(-2), ['box', 'sh -s']);
  });

  test('add persists without secrets', () => {
    const c = mgr.add({ name: 'Prod 1', host: 'box', remotePort });
    assert.equal(c.id, 'prod-1');
    assert.equal(mgr.add({ name: 'Prod 1', host: 'box2' }).id, 'prod-1-2');
    void mgr.remove('prod-1-2');
    const saved = JSON.parse(readFileSync(join(root, 'data', 'servers.json'), 'utf8'));
    assert.equal(saved.servers[0].host, 'box');
  });

  test('preflight passes on a healthy server', async () => {
    const r = await mgr.preflight('prod-1');
    const failed = r.checks.filter((c) => c.status === 'fail');
    assert.deepEqual(failed, []);
    assert.equal(r.checks.find((c) => c.id === 'auth')!.status, 'pass');
    assert.equal(r.systemd, false);
    assert.ok(r.nodePath);
  });

  test('auth failure is explained', async () => {
    const id = mgr.add({ name: 'nope', host: 'denied-host' }).id;
    const r = await mgr.preflight(id);
    assert.equal(r.ok, false);
    assert.match(r.checks[0].detail, /authentication failed/);
    await mgr.remove(id);
  });

  test('connect before deploy reports it clearly', async () => {
    mgr.connect('prod-1');
    await until(() => /not deployed/.test(lastSnap?.servers.find((s) => s.config.id === 'prod-1')?.status.message ?? ''), 10_000, 'not-deployed message');
    await mgr.disconnect('prod-1');
  });

  test('deploy installs the node (nohup fallback) and start.sh is idempotent', async () => {
    await mgr.deploy('prod-1');
    const st = mgr.snapshot().servers[0].status;
    assert.equal(st.deployMode, 'nohup');
    for (const f of ['axo-node.mjs', 'axo-node.json', 'start.sh', 'stop.sh']) assert.ok(existsSync(join(remoteHome, '.axo/bin', f)), f);
    const pid1 = JSON.parse(readFileSync(join(remoteHome, '.axo/node.pid'), 'utf8')).pid;
    execFileSync('sh', [join(remoteHome, '.axo/bin/start.sh')], { env: { ...process.env, HOME: remoteHome } });
    assert.equal(JSON.parse(readFileSync(join(remoteHome, '.axo/node.pid'), 'utf8')).pid, pid1);
    // The node installs the axo CLI next to our files; agents get ~/.axo/bin first on PATH.
    for (const f of ['axo', 'axo.mjs', 'knock.sh']) assert.ok(existsSync(join(remoteHome, '.axo/bin', f)), f);
    const help = execFileSync(join(remoteHome, '.axo/bin/axo'), ['help'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: remoteHome } });
    assert.match(help, /axo/);
  });

  test('connect opens a tunnel and registers the node', async () => {
    mgr.connect('prod-1');
    await until(() => lastConns.some((c) => c.key === 'prod-1'), 20_000, 'remote conn');
    await until(() => mgr.snapshot().servers[0].status.phase === 'connected', 20_000, 'connected');
    const conn = lastConns.find((c) => c.key === 'prod-1')!;
    assert.equal(conn.kind, 'remote');
    assert.equal(conn.token, readFileSync(join(remoteHome, '.axo/node.token'), 'utf8').trim());
    const v = (await (await fetch(`${conn.baseUrl}/api/version`, { headers: { Authorization: `Bearer ${conn.token}` } })).json()) as VersionInfo;
    assert.equal(v.build, bundleInfo().build);
    await until(() => !!mgr.snapshot().servers[0].status.node, 5000, 'version');
    assert.equal(mgr.snapshot().servers[0].status.updateAvailable, false);
    const tunnel = JSON.parse(readFileSync(process.env.FAKE_SSH_LOG!, 'utf8').trim().split('\n').filter((l) => l.includes('"-N"')).pop()!) as string[];
    assert.ok(tunnel.includes('ExitOnForwardFailure=yes'));
    assert.ok(tunnel.includes(`127.0.0.1:${new URL(conn.baseUrl).port}:127.0.0.1:${remotePort}`));
  });

  test('reconnects on wake, keeping the same local port', async () => {
    const before = lastConns.find((c) => c.key === 'prod-1')!.baseUrl;
    mgr.kickAll();
    await until(() => mgr.snapshot().servers[0].status.phase !== 'connected', 5000, 'drop');
    await until(() => mgr.snapshot().servers[0].status.phase === 'connected', 20_000, 'reconnected');
    assert.equal(lastConns.find((c) => c.key === 'prod-1')!.baseUrl, before);
  });

  test('redeploy while connected restarts the node and the tunnel recovers', async () => {
    const pid1 = JSON.parse(readFileSync(join(remoteHome, '.axo/node.pid'), 'utf8')).pid;
    await mgr.deploy('prod-1');
    const pid2 = JSON.parse(readFileSync(join(remoteHome, '.axo/node.pid'), 'utf8')).pid;
    assert.notEqual(pid1, pid2);
    await until(() => mgr.snapshot().servers[0].status.phase === 'connected', 30_000, 'connected after redeploy');
    const conn = lastConns.find((c) => c.key === 'prod-1')!;
    assert.ok((await fetch(`${conn.baseUrl}/api/health`)).ok);
  });

  test('an unexpected drop that does not heal raises server-lost; a wake-up reconnect does not', async () => {
    const lost: string[] = [];
    mgr.on('server-lost', (cfg: { name: string }) => lost.push(cfg.name));
    mgr.kickAll(); // intentional reconnect: no notification
    await until(() => mgr.snapshot().servers[0].status.phase === 'connected', 20_000, 'reconnected after kick');
    await new Promise((r) => setTimeout(r, 600));
    assert.deepEqual(lost, []);
    // Server becomes unreachable: tunnel dies and new ssh connections are refused.
    process.env.FAKE_SSH_FAIL = 'auth';
    const port = new URL(lastConns.find((c) => c.key === 'prod-1')!.baseUrl).port;
    execFileSync('pkill', ['-f', `127.0.0.1:${port}:127.0.0.1:${remotePort}`]);
    await until(() => lost.length === 1, 10_000, 'server-lost');
    assert.deepEqual(lost, ['Prod 1']);
    delete process.env.FAKE_SSH_FAIL;
    mgr.kickAll();
    await until(() => mgr.snapshot().servers[0].status.phase === 'connected', 30_000, 'recovered');
  });

  test('disconnect removes the node from the renderer but leaves it running', async () => {
    await mgr.disconnect('prod-1');
    await until(() => !lastConns.some((c) => c.key === 'prod-1'), 5000, 'conn removed');
    assert.equal(mgr.snapshot().servers[0].config.autoConnect, false);
    const out = execFileSync('sh', ['-c', `node -e "fetch('http://127.0.0.1:${remotePort}/api/health').then(r=>console.log(r.status))"`], { encoding: 'utf8' });
    assert.equal(out.trim(), '200');
  });
});

describe('local node update', () => {
  test('waits for agents to finish, then restarts on the bundled build', async () => {
    let polls = 0;
    let build = 'old';
    const srv: Server = createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api/version') return res.end(JSON.stringify({ version: '0.1.0', build, nodeId: 'n', hostname: 'h' }));
      if (req.url === '/api/state') {
        polls++;
        const status = polls < 3 ? 'working' : 'idle';
        return res.end(JSON.stringify({ agents: [{ id: 'a', status }] }));
      }
      res.statusCode = 404; res.end('{}');
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(srv.address() as any).port}`;
    const root = mkdtempSync(join(tmpdir(), 'axo-local-'));
    let restarts = 0;
    const mgr = new NodeManager({
      dataDir: root, sshEnv: { sshBin: FAKE_SSH, controlDir: join(root, 'ctl') }, readBundle: () => Buffer.from(''),
      bundleInfo: { version: '0.1.0', build: 'new' }, idlePollMs: 20,
      restartLocal: async () => { restarts++; assert.ok(polls >= 3, 'restarted while an agent was working'); build = 'new'; return { baseUrl: base, token: 't' }; },
    });
    await mgr.setLocal({ baseUrl: base, token: 't' });
    assert.equal(mgr.snapshot().local.updateAvailable, true);
    await mgr.updateLocal();
    assert.equal(restarts, 1);
    assert.equal(mgr.snapshot().local.updateAvailable, false);
    assert.equal(mgr.snapshot().local.node?.build, 'new');
    srv.close();
    rmSync(root, { recursive: true, force: true });
  });
});
