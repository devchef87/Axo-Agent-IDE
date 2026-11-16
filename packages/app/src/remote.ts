// What Axo runs on a server: preflight probe, deploy, start/stop. Every script
// is POSIX sh sent over `ssh … sh -s`; values are interpolated with shq().

import { createHash } from 'node:crypto';
import type { PreflightCheck, PreflightResult } from '@axo/protocol';
import { sshExec, explainSshError, type SshEnv, type SshTarget } from './ssh.ts';

export const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

// ── Preflight ───────────────────────────────────────────────

export function preflightScript(remotePort: number): string {
  return String.raw`
export XDG_RUNTIME_DIR="${'$'}{XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
kv() { printf '%s=%s\n' "$1" "$(printf '%s' "$2" | head -n 1)"; }
kv os "$(uname -s)"
kv kernel "$(uname -r)"
kv arch "$(uname -m)"
[ -r /etc/os-release ] && kv distro "$(. /etc/os-release; echo "$PRETTY_NAME")"
kv user "$(id -un)"
TO=""; command -v timeout >/dev/null 2>&1 && TO="timeout 15"
# Agents need the same PATH an interactive login gets (nvm, ~/.local/bin, …).
LP=$($TO "${'$'}{SHELL:-/bin/sh}" -ilc 'printf "__AXO__%s__AXO__" "$PATH"' </dev/null 2>/dev/null | sed -n 's/.*__AXO__\(.*\)__AXO__.*/\1/p' | tail -n 1)
[ -n "$LP" ] && PATH="$LP:$PATH"
NVM=$(ls -d "$HOME"/.nvm/versions/node/v*/bin 2>/dev/null | sort -V | tail -n 1)
for d in "$HOME/.local/bin" "$HOME/.npm-global/bin" "$HOME/.volta/bin" "$HOME/.bun/bin" "$NVM" /usr/local/bin /usr/bin /bin; do
  [ -n "$d" ] && [ -d "$d" ] && case ":$PATH:" in *":$d:"*) ;; *) PATH="$PATH:$d" ;; esac
done
export PATH
NODE=$(command -v node 2>/dev/null)
# The default node may be too old for Axo (node:sqlite needs 22.5+) while a newer one sits beside it
# (e.g. nvm default 20, plus 22 installed for Axo). Prefer PATH's node if new enough, else the newest that is.
okv() { "$1" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=5)?0:1)' 2>/dev/null; }
if [ -z "$NODE" ] || ! okv "$NODE"; then
  for n in $(ls -d "$HOME"/.nvm/versions/node/v*/bin/node "$HOME"/.volta/bin/node /usr/local/bin/node /usr/bin/node 2>/dev/null | sort -rV); do
    if [ -x "$n" ] && okv "$n"; then NODE="$n"; PATH="$(dirname "$n"):$PATH"; export PATH; break; fi
  done
fi
kv node "$NODE"
kv path "$PATH"
[ -n "$NODE" ] && kv node_version "$("$NODE" --version 2>&1)"
CL=$(command -v claude 2>/dev/null)
kv claude "$CL"
if [ -n "$CL" ]; then
  kv claude_version "$($TO "$CL" --version 2>&1)"
  kv claude_auth "$($TO "$CL" auth status --json 2>/dev/null | tr -d '\n' | grep -oE '"(loggedIn|authMethod|subscriptionType)": *[^,}]*' | tr '\n' ' ')"
fi
G=$(command -v git 2>/dev/null)
kv git "$G"
[ -n "$G" ] && kv git_version "$(git --version 2>&1)"
kv disk_kb "$(df -Pk "$HOME" 2>/dev/null | awk 'NR==2{print $4}')"
if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then kv systemd 1; fi
command -v loginctl >/dev/null 2>&1 && kv linger "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null)"
[ -f "$HOME/.axo/bin/axo-node.json" ] && kv deployed "$(tr -d '\n' < "$HOME/.axo/bin/axo-node.json")"
[ -f "$HOME/.axo/node.pid" ] && kv axo_pidfile 1
if [ -n "$NODE" ]; then
  probe() { "$NODE" -e "fetch('http://127.0.0.1:$1$2',{signal:AbortSignal.timeout(2000)}).then(r=>process.exit($3),()=>process.exit(1))" 2>/dev/null; }
  probe 31415 / 0 && kv groove 1
  probe ${remotePort} / 0 && kv port_in_use 1
  probe ${remotePort} /api/health 'r.ok?0:1' && kv axo_running 1
fi
echo AXO_PREFLIGHT_DONE
`;
}

export function parseKv(stdout: string): Record<string, string> {
  const kv: Record<string, string> = {};
  for (const line of stdout.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0 && /^[a-z_]+$/.test(line.slice(0, i))) kv[line.slice(0, i)] = line.slice(i + 1).trim();
  }
  return kv;
}

/** node:sqlite: unflagged from 22.13 / 23.4; behind --experimental-sqlite from 22.5. */
export function nodeSupport(v: string): { status: 'pass' | 'warn' | 'fail'; flags: string[]; detail: string } {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  if (!m) return { status: 'fail', flags: [], detail: `unrecognised version "${v}"` };
  const [maj, min] = [Number(m[1]), Number(m[2])];
  const ver = `v${m[1]}.${m[2]}.${m[3]}`;
  if (maj >= 24 || (maj === 23 && min >= 4) || (maj === 22 && min >= 13)) return { status: 'pass', flags: [], detail: ver };
  if ((maj === 22 && min >= 5) || maj === 23) return { status: 'warn', flags: ['--experimental-sqlite'], detail: `${ver}: works with --experimental-sqlite; upgrade to ≥ 22.13 recommended` };
  return { status: 'fail', flags: [], detail: `${ver}: Axo needs node ≥ 22.13 (node:sqlite). Upgrade node on the server, e.g. nvm install 22` };
}

export function evaluatePreflight(kv: Record<string, string>, remotePort: number): PreflightResult {
  const checks: PreflightCheck[] = [];
  const add = (id: string, label: string, status: PreflightCheck['status'], detail: string) => checks.push({ id, label, status, detail });

  const os = kv.os ?? '';
  add('os', 'Operating system', os === 'Linux' ? 'pass' : os ? 'warn' : 'fail',
    os === 'Linux' ? `${kv.distro ?? 'Linux'} (${kv.arch ?? '?'})` : os ? `${os}: only Linux is supported for servers` : 'could not detect');

  let flags: string[] = [];
  if (!kv.node) add('node', 'Node.js', 'fail', 'node not found on the login PATH. Install node ≥ 22.13 (e.g. nvm install 22)');
  else {
    const s = nodeSupport(kv.node_version ?? '');
    flags = s.flags;
    add('node', 'Node.js', s.status, `${s.detail} at ${kv.node}`);
  }

  if (!kv.claude) add('claude', 'Claude Code', 'fail', 'claude not found on the login PATH. Install: npm i -g @anthropic-ai/claude-code');
  else add('claude', 'Claude Code', 'pass', `${(kv.claude_version ?? '').replace(/\s*\(Claude Code\)/, '')} at ${kv.claude}`);

  if (kv.claude) {
    const auth = kv.claude_auth ?? '';
    const method = /"authMethod": *"([^"]*)"/.exec(auth)?.[1];
    const sub = /"subscriptionType": *"([^"]*)"/.exec(auth)?.[1];
    if (/"loggedIn": *true/.test(auth)) add('auth', 'Claude login', 'pass', [method, sub].filter(Boolean).join(' · ') || 'logged in');
    else if (/"loggedIn": *false/.test(auth)) add('auth', 'Claude login', 'fail', 'Not logged in. SSH in and run `claude` once to log in (or `claude setup-token`).');
    else add('auth', 'Claude login', 'warn', 'Could not read `claude auth status`; make sure claude is logged in on the server.');
  }

  if (!kv.git) add('git', 'git', 'warn', 'git not found. Worktree teams need git.');
  else add('git', 'git', 'pass', (kv.git_version ?? '').replace(/^git version /, 'v'));

  const kb = Number(kv.disk_kb);
  if (!Number.isFinite(kb) || !kv.disk_kb) add('disk', 'Free disk', 'warn', 'unknown');
  else {
    const gb = kb / 1024 / 1024;
    add('disk', 'Free disk', gb < 1 ? 'fail' : gb < 5 ? 'warn' : 'pass', `${gb.toFixed(1)} GB free in $HOME`);
  }

  const systemd = kv.systemd === '1';
  const linger = kv.linger === 'yes';
  if (systemd && linger) add('service', 'Service manager', 'pass', 'systemd --user, linger on (survives logout and reboot)');
  else if (systemd) add('service', 'Service manager', 'warn', 'systemd --user, linger off. Deploy runs `loginctl enable-linger`; if that is refused, it falls back to nohup');
  else add('service', 'Service manager', 'warn', 'systemd --user not available. Falls back to nohup + pidfile (no restart after reboot)');

  if (kv.port_in_use && !kv.axo_running) add('port', `Port ${remotePort}`, 'fail', `Something other than Axo is listening on 127.0.0.1:${remotePort}`);
  else add('port', `Port ${remotePort}`, 'pass', kv.axo_running ? 'Axo node running' : 'free');

  add('groove', 'Groove', 'pass', kv.groove ? 'Groove running on :31415 (Axo runs alongside it)' : 'not running');

  let deployedBuild: string | undefined;
  try { deployedBuild = kv.deployed ? JSON.parse(kv.deployed).build : undefined; } catch { /* ignore */ }

  return {
    ok: !checks.some((c) => c.status === 'fail'),
    ts: Date.now(),
    checks,
    nodePath: kv.node || undefined,
    nodeFlags: flags,
    pathEnv: kv.path || undefined,
    systemd,
    linger,
    deployedBuild,
  };
}

export async function runPreflight(env: SshEnv, t: SshTarget, remotePort: number): Promise<PreflightResult> {
  const r = await sshExec(env, t, preflightScript(remotePort), { timeoutMs: 60_000 });
  if (!r.stdout.includes('AXO_PREFLIGHT_DONE')) {
    return {
      ok: false, ts: Date.now(), nodeFlags: [], systemd: false, linger: false,
      checks: [{ id: 'ssh', label: 'SSH connection', status: 'fail', detail: explainSshError(r.stderr, r.code) }],
    };
  }
  const res = evaluatePreflight(parseKv(r.stdout), remotePort);
  res.checks.unshift({ id: 'ssh', label: 'SSH connection', status: 'pass', detail: 'connected' });
  return res;
}

// ── Deploy / start / stop ───────────────────────────────────

export interface DeployParams {
  nodePath: string;
  nodeFlags: string[];
  pathEnv: string;
  remotePort: number;
  bundle: Buffer;
  bundleInfo: { version: string; build: string };
  allowSystemd: boolean;
}

/** systemd unit. `%` is a specifier character in unit files, so escape it in values. */
export function systemdUnit(p: { nodePath: string; nodeFlags: string[]; pathEnv: string; remotePort: number }): string {
  const esc = (s: string) => s.replace(/%/g, '%%').replace(/"/g, '\\"');
  const exec = [
    ...[p.nodePath, ...p.nodeFlags, '--disable-warning=ExperimentalWarning'].map((a) => `"${esc(a)}"`),
    '%h/.axo/bin/axo-node.mjs', '--port', String(p.remotePort),
  ].join(' ');
  return `[Unit]
Description=Axo node (agent runtime)
After=network-online.target

[Service]
Type=simple
WorkingDirectory=%h
Environment="PATH=${esc(p.pathEnv)}"
Environment="AXO_HOME=%h/.axo"
ExecStart=${exec}
Restart=on-failure
RestartSec=3
# SIGTERM to the node only; it stops its claude processes itself (they resume by session).
KillMode=mixed
TimeoutStopSec=25

[Install]
WantedBy=default.target
`;
}

/**
 * ~/.axo/bin/start.sh: idempotent "make sure the node is up", baked with the
 * exact node path, flags and PATH found by preflight. Also usable by hand.
 */
export function startScript(p: { nodePath: string; nodeFlags: string[]; pathEnv: string; remotePort: number; mode: 'systemd' | 'nohup' }): string {
  const node = shq(p.nodePath);
  const health = `${node} -e "fetch('http://127.0.0.1:${p.remotePort}/api/health',{signal:AbortSignal.timeout(1500)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" 2>/dev/null`;
  const launch = p.mode === 'systemd'
    ? `export XDG_RUNTIME_DIR="\${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"\nsystemctl --user start axo-node.service`
    : [
        'cd "$HOME"',
        'S=""; command -v setsid >/dev/null 2>&1 && S=setsid',
        `PATH=${shq(p.pathEnv)} AXO_HOME="$HOME/.axo" nohup $S ${node} ${p.nodeFlags.map(shq).join(' ')} --disable-warning=ExperimentalWarning "$HOME/.axo/bin/axo-node.mjs" --port ${p.remotePort} >> "$HOME/.axo/logs/node.log" 2>&1 < /dev/null &`,
      ].join('\n');
  return `#!/bin/sh
# Generated by Axo (${p.mode}). Starts the Axo node if it isn't running.
mkdir -p "$HOME/.axo/logs"
health() { ${health}; }
health && exit 0
${launch}
i=0
while [ $i -lt 40 ]; do
  health && exit 0
  sleep 0.5; i=$((i+1))
done
echo "Axo node did not become healthy. Last log lines:" >&2
tail -n 20 "$HOME/.axo/logs/node.log" >&2 2>/dev/null
exit 1
`;
}

/** ~/.axo/bin/stop.sh: stops whichever way the node was started. */
export function stopScript(): string {
  return `#!/bin/sh
# Generated by Axo. Stops the Axo node (systemd unit and/or pidfile).
export XDG_RUNTIME_DIR="\${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
if command -v systemctl >/dev/null 2>&1 && [ -f "$HOME/.config/systemd/user/axo-node.service" ]; then
  systemctl --user stop axo-node.service 2>/dev/null
fi
PF="$HOME/.axo/node.pid"
if [ -f "$PF" ]; then
  PID=$(sed -n 's/.*"pid": *\\([0-9]*\\).*/\\1/p' "$PF")
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    kill -TERM "$PID"
    i=0
    while kill -0 "$PID" 2>/dev/null && [ $i -lt 50 ]; do sleep 0.5; i=$((i+1)); done
    kill -0 "$PID" 2>/dev/null && kill -KILL "$PID"
  fi
fi
exit 0
`;
}

export function installScript(p: Omit<DeployParams, 'bundle'> & { sha256: string }): string {
  const unit = systemdUnit(p);
  const writeFile = (path: string, body: string, mode?: string) =>
    `cat > ${path} <<'AXO_EOF'\n${body}AXO_EOF\n${mode ? `chmod ${mode} ${path}\n` : ''}`;
  return `set -e
BIN="$HOME/.axo/bin"
mkdir -p "$BIN" "$HOME/.axo/logs"
NODE=${shq(p.nodePath)}
GOT=$("$NODE" -e "const h=require('crypto').createHash('sha256');h.update(require('fs').readFileSync(process.argv[1]));console.log(h.digest('hex'))" "$BIN/.axo-node.upload")
if [ "$GOT" != ${shq(p.sha256)} ]; then echo "upload corrupted (sha256 mismatch)" >&2; exit 2; fi
${writeFile('"$BIN/stop.sh"', stopScript(), '755')}
# Stop the old node before swapping the bundle; agents resume by session on start.
sh "$BIN/stop.sh"
mv -f "$BIN/.axo-node.upload" "$BIN/axo-node.mjs"
printf '%s\\n' ${shq(JSON.stringify(p.bundleInfo))} > "$BIN/axo-node.json"
MODE=nohup
${p.allowSystemd ? `export XDG_RUNTIME_DIR="\${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  L=$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null || true)
  if [ "$L" != yes ]; then loginctl enable-linger "$(id -un)" >/dev/null 2>&1 || true; L=$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null || true); fi
  if [ "$L" = yes ]; then MODE=systemd; else echo "warn=linger could not be enabled; using nohup" ; fi
fi` : ''}
if [ "$MODE" = systemd ]; then
  mkdir -p "$HOME/.config/systemd/user"
${writeFile('"$HOME/.config/systemd/user/axo-node.service"', unit)}
  systemctl --user daemon-reload
  systemctl --user enable axo-node.service >/dev/null 2>&1
${writeFile('"$BIN/start.sh"', startScript({ ...p, mode: 'systemd' }), '755')}
else
  if [ -f "$HOME/.config/systemd/user/axo-node.service" ]; then systemctl --user disable axo-node.service >/dev/null 2>&1 || true; rm -f "$HOME/.config/systemd/user/axo-node.service"; fi
${writeFile('"$BIN/start.sh"', startScript({ ...p, mode: 'nohup' }), '755')}
fi
echo "mode=$MODE"
sh "$BIN/start.sh"
echo AXO_DEPLOY_OK
`;
}

export interface DeployResult { mode: 'systemd' | 'nohup'; warnings: string[] }

export async function deploy(env: SshEnv, t: SshTarget, p: DeployParams, log: (m: string) => void = () => {}): Promise<DeployResult> {
  log('Uploading node bundle…');
  const up = await sshExec(env, t, '', {
    command: `sh -c 'mkdir -p "$HOME/.axo/bin" && cat > "$HOME/.axo/bin/.axo-node.upload"'`,
    stdin: p.bundle,
    timeoutMs: 180_000,
  });
  if (up.code !== 0) throw new Error(`Upload failed: ${explainSshError(up.stderr, up.code)}`);

  log('Installing service and starting node…');
  const sha256 = createHash('sha256').update(p.bundle).digest('hex');
  const r = await sshExec(env, t, installScript({ ...p, sha256 }), { timeoutMs: 120_000 });
  if (!r.stdout.includes('AXO_DEPLOY_OK')) {
    const err = r.stderr.trim().split('\n').slice(-12).join('\n');
    throw new Error(`Deploy failed${err ? `:\n${err}` : ` (exit ${r.code})`}`);
  }
  const kv = parseKv(r.stdout);
  return { mode: kv.mode === 'systemd' ? 'systemd' : 'nohup', warnings: kv.warn ? [kv.warn] : [] };
}

/** Ensure the node runs (start.sh) and read its token, in one round trip. */
export async function startAndReadToken(env: SshEnv, t: SshTarget): Promise<string> {
  const r = await sshExec(env, t, `
if [ ! -x "$HOME/.axo/bin/start.sh" ]; then echo "AXO_NOT_DEPLOYED"; exit 3; fi
sh "$HOME/.axo/bin/start.sh" || exit 4
printf 'AXO_TOKEN=%s\\n' "$(cat "$HOME/.axo/node.token")"
`, { timeoutMs: 60_000 });
  if (r.stdout.includes('AXO_NOT_DEPLOYED')) throw new Error('Axo is not deployed on this server yet. Run Deploy first.');
  const token = /AXO_TOKEN=(\S+)/.exec(r.stdout)?.[1];
  if (r.code !== 0 || !token) throw new Error(r.code === 4 ? `Node failed to start:\n${r.stderr.trim()}` : explainSshError(r.stderr, r.code));
  return token;
}

export async function stopRemote(env: SshEnv, t: SshTarget): Promise<void> {
  const r = await sshExec(env, t, `[ -x "$HOME/.axo/bin/stop.sh" ] && sh "$HOME/.axo/bin/stop.sh"; exit 0`, { timeoutMs: 60_000 });
  if (r.code !== 0) throw new Error(explainSshError(r.stderr, r.code));
}
