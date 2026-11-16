// Starts (or attaches to) the local Axo node. The node runs detached from the
// app so closing the window never kills local agents — same as on servers.

import { spawn, execFileSync } from 'node:child_process';
import { existsSync, openSync, readFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const LOCAL_PORT = Number(process.env.AXO_PORT) || 31500;
const HOME = process.env.AXO_HOME || join(homedir(), '.axo');

export interface LocalNode { baseUrl: string; token: string; version: string; build: string }

async function health(baseUrl: string, token: string): Promise<{ version: string; build?: string } | null> {
  try {
    const r = await fetch(`${baseUrl}/api/version`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1500) });
    return r.ok ? ((await r.json()) as { version: string }) : null;
  } catch {
    return null;
  }
}

function readToken(): string | null {
  const f = join(HOME, 'node.token');
  return existsSync(f) ? readFileSync(f, 'utf8').trim() : null;
}

/** macOS apps launched from Finder get a minimal PATH; agents need the user's shell PATH to find `claude`, git, node… */
let shellPath: string | null = null;
export function loginShellPath(): string {
  if (shellPath) return shellPath;
  const fallback = [process.env.PATH, '/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local/bin')].filter(Boolean).join(':');
  try {
    const shell = process.env.SHELL || '/bin/zsh';
    const out = execFileSync(shell, ['-ilc', 'printf "__AXO__%s__AXO__" "$PATH"'], { encoding: 'utf8', timeout: 5000 });
    shellPath = /__AXO__(.*)__AXO__/.exec(out)?.[1] || fallback;
  } catch {
    shellPath = fallback;
  }
  return shellPath;
}

export async function ensureLocalNode(bundlePath: string): Promise<LocalNode> {
  const baseUrl = `http://127.0.0.1:${LOCAL_PORT}`;
  let token = readToken();
  if (token) {
    const h = await health(baseUrl, token);
    if (h) return { baseUrl, token, version: h.version, build: h.build ?? 'unknown' };
  }

  if (!existsSync(bundlePath)) throw new Error(`Axo node bundle missing at ${bundlePath} — run npm run build`);
  mkdirSync(join(HOME, 'logs'), { recursive: true });
  const log = openSync(join(HOME, 'logs', 'node.log'), 'a');
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', bundlePath, '--port', String(LOCAL_PORT)], {
    detached: true,
    stdio: ['ignore', log, log],
    cwd: homedir(),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PATH: loginShellPath(), AXO_HOME: HOME },
  });
  child.unref();

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    token = token ?? readToken();
    if (!token) continue;
    const h = await health(baseUrl, token);
    if (h) return { baseUrl, token, version: h.version, build: h.build ?? 'unknown' };
  }
  throw new Error(`Local Axo node did not start. See ${join(HOME, 'logs', 'node.log')}`);
}

export async function stopLocalNode(): Promise<void> {
  const f = join(HOME, 'node.pid');
  if (!existsSync(f)) return;
  try {
    const { pid } = JSON.parse(readFileSync(f, 'utf8'));
    process.kill(pid, 'SIGTERM');
    const deadline = Date.now() + 15_000; // agents get time to stop cleanly (they resume by session)
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
      try { process.kill(pid, 0); } catch { return; }
    }
    // A wedged node would otherwise keep the port and the database while a new one starts.
    process.kill(pid, 'SIGKILL');
    for (let i = 0; i < 25; i++) {
      await new Promise((r) => setTimeout(r, 200));
      try { process.kill(pid, 0); } catch { return; }
    }
  } catch { /* not running */ }
}
