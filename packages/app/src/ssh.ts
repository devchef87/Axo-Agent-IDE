// Thin wrapper over the system `ssh`. Using the real binary means ~/.ssh/config,
// ssh-agent, Keychain passphrases, ProxyJump etc. all work exactly as in the
// user's terminal; Axo never sees a secret.

import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, isAbsolute, basename } from 'node:path';
import type { SshHostEntry } from '@axo/protocol';

export interface SshTarget { host: string; user?: string; port?: number; identityFile?: string }

export interface SshEnv {
  sshBin: string;       // 'ssh', or a fake in tests
  controlDir: string;   // ControlMaster sockets; keep short (macOS caps socket paths at 104 bytes)
}

export interface ExecResult { code: number; stdout: string; stderr: string }

const SAFE = /^[A-Za-z0-9_.@%:\[\]-]+$/;

/** Reject anything that ssh could parse as an option or that isn't a plain host/user token. */
export function validateTarget(t: SshTarget): void {
  if (!t.host || t.host.startsWith('-') || !SAFE.test(t.host)) throw new Error(`Invalid host "${t.host}"`);
  if (t.user && (t.user.startsWith('-') || !/^[A-Za-z0-9_.-]+$/.test(t.user))) throw new Error(`Invalid user "${t.user}"`);
  if (t.port !== undefined && !(Number.isInteger(t.port) && t.port > 0 && t.port < 65536)) throw new Error(`Invalid port "${t.port}"`);
}

function baseArgs(env: SshEnv, t: SshTarget, mux: boolean): string[] {
  validateTarget(t);
  const a = [
    '-o', 'BatchMode=yes',                    // never prompt: there is no tty
    '-o', 'StrictHostKeyChecking=accept-new', // first connect to a new host records its key; changed keys still fail
    '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
  ];
  if (mux) a.push('-o', 'ControlMaster=auto', '-o', `ControlPath=${join(env.controlDir, '%C')}`, '-o', 'ControlPersist=120');
  else a.push('-o', 'ControlMaster=no', '-o', 'ControlPath=none');
  if (t.user) a.push('-o', `User=${t.user}`);
  if (t.port) a.push('-o', `Port=${t.port}`);
  if (t.identityFile) a.push('-i', expandHome(t.identityFile));
  return a;
}

/**
 * Run a POSIX sh script on the server. The script travels on stdin (`sh -s`),
 * so nothing is subject to remote shell quoting. `stdin` replaces the script
 * when `command` is given (used for file uploads).
 */
export function sshExec(env: SshEnv, t: SshTarget, script: string, opts: { timeoutMs?: number; command?: string; stdin?: Buffer } = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    const args = [...baseArgs(env, t, true), t.host, opts.command ?? 'sh -s'];
    const child = spawn(env.sshBin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    // Resolve on exit + stdout end, not 'close': a ControlPersist master forked by
    // this ssh inherits our stderr pipe and would hold 'close' open for minutes.
    let exitCode: number | null = null;
    let outEnded = false;
    let done = false;
    const finish = () => {
      if (done || exitCode === null || !outEnded) return;
      done = true;
      clearTimeout(timer);
      child.stderr.destroy();
      resolve({ code: exitCode, stdout, stderr });
    };
    const timer = setTimeout(() => { stderr += '\n[axo] timed out'; child.kill('SIGKILL'); }, opts.timeoutMs ?? 60_000);
    child.on('error', (e) => { if (done) return; done = true; clearTimeout(timer); resolve({ code: 127, stdout, stderr: stderr + e.message }); });
    child.on('exit', (code, sig) => { exitCode = code ?? (sig ? 255 : 0); finish(); });
    child.stdout.on('end', () => { outEnded = true; finish(); });
    child.stdin.on('error', () => { /* remote closed early; exit code tells the story */ });
    child.stdin.end(opts.stdin ?? script);
  });
}

/** Long-lived `ssh -N -L` on a dedicated connection (not the mux master, so a dying master can't take it down). */
export function sshTunnel(env: SshEnv, t: SshTarget, localPort: number, remotePort: number): ChildProcess {
  const args = [
    ...baseArgs(env, t, false),
    '-o', 'ExitOnForwardFailure=yes',
    '-N', '-L', `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
    t.host,
  ];
  return spawn(env.sshBin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
}

/** Make ssh errors readable in the UI. */
export function explainSshError(stderr: string, code: number): string {
  const s = stderr.trim();
  if (/Permission denied/i.test(s)) return 'SSH authentication failed. Add the key to ssh-agent (ssh-add --apple-use-keychain <key>) or set an identity file.';
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(s)) return 'Host key mismatch. Check ~/.ssh/known_hosts for this server.';
  if (/Could not resolve hostname/i.test(s)) return 'Could not resolve the hostname.';
  if (/timed out|Connection timed out/i.test(s)) return 'Connection timed out.';
  if (/Connection refused/i.test(s)) return 'Connection refused (is sshd running on that port?).';
  const last = s.split('\n').filter(Boolean).pop();
  return last ? last : `ssh exited with code ${code}`;
}

export function expandHome(p: string): string {
  return p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
}

// ── ~/.ssh/config import ────────────────────────────────────

/** Parse Host blocks (following Include) into importable entries. Wildcard patterns are skipped. */
export function parseSshConfig(file = join(homedir(), '.ssh', 'config')): SshHostEntry[] {
  const out: SshHostEntry[] = [];
  const seen = new Set<string>();
  const visit = (path: string, depth: number) => {
    if (depth > 8 || !existsSync(path)) return;
    let text: string;
    try { text = readFileSync(path, 'utf8'); } catch { return; }
    let current: SshHostEntry[] = [];
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const m = /^(\S+?)\s*(?:=\s*|\s+)(.+)$/.exec(line);
      if (!m) continue;
      const key = m[1].toLowerCase();
      const value = m[2].trim().replace(/^"(.*)"$/, '$1');
      if (key === 'include') {
        for (const pattern of value.split(/\s+/)) for (const f of expandInclude(pattern)) visit(f, depth + 1);
        continue;
      }
      if (key === 'match') { current = []; continue; }
      if (key === 'host') {
        current = [];
        for (const alias of value.split(/\s+/)) {
          if (/[*?!]/.test(alias) || seen.has(alias)) continue;
          seen.add(alias);
          const e: SshHostEntry = { alias };
          out.push(e);
          current.push(e);
        }
        continue;
      }
      // ssh uses the first value it sees for a key.
      for (const e of current) {
        if (key === 'hostname' && !e.hostName) e.hostName = value;
        else if (key === 'user' && !e.user) e.user = value;
        else if (key === 'port' && !e.port) e.port = Number(value) || undefined;
        else if (key === 'identityfile' && !e.identityFile) e.identityFile = value;
      }
    }
  };
  visit(file, 0);
  return out;
}

function expandInclude(pattern: string): string[] {
  let p = expandHome(pattern);
  if (!isAbsolute(p)) p = join(homedir(), '.ssh', p);
  if (!/[*?]/.test(basename(p))) return [p];
  const dir = dirname(p);
  const re = new RegExp('^' + basename(p).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
  try { return readdirSync(dir).filter((f) => re.test(f)).sort().map((f) => join(dir, f)); } catch { return []; }
}
