import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { ulid } from './util/ulid.ts';

declare const __AXO_VERSION__: string | undefined;
declare const __AXO_BUILD__: string | undefined;
export const VERSION: string = typeof __AXO_VERSION__ !== 'undefined' ? __AXO_VERSION__ : '0.1.0-dev';
/** Content hash of the bundle sources; 'dev' when running from source. */
export const BUILD: string = typeof __AXO_BUILD__ !== 'undefined' ? __AXO_BUILD__ : 'dev';
export const DEFAULT_PORT = 31500;

export interface NodeConfig {
  home: string;            // ~/.axo
  port: number;
  host: string;
  nodeId: string;
  token: string;
  hostname: string;
  claudeBin: string;
  uiDir: string | null;    // serve built UI from here (local node only)
  idleReapMs: number;      // kill idle claude processes after this; resumed on next message
  authMode: 'subscription' | 'api';
}

interface Persisted { nodeId: string; token: string }

export function loadConfig(overrides: Partial<NodeConfig> = {}): NodeConfig {
  const home = overrides.home ?? process.env.AXO_HOME ?? join(homedir(), '.axo');
  mkdirSync(join(home, 'logs'), { recursive: true });
  mkdirSync(join(home, 'agents'), { recursive: true });

  const idFile = join(home, 'node.json');
  let persisted: Persisted;
  if (existsSync(idFile)) {
    persisted = JSON.parse(readFileSync(idFile, 'utf8'));
  } else {
    persisted = { nodeId: ulid(), token: randomBytes(24).toString('base64url') };
    writeFileSync(idFile, JSON.stringify(persisted, null, 2));
    chmodSync(idFile, 0o600);
  }
  // Token in its own file too, so tunnels/CLI can `cat` it.
  const tokenFile = join(home, 'node.token');
  if (!existsSync(tokenFile)) {
    writeFileSync(tokenFile, persisted.token);
    chmodSync(tokenFile, 0o600);
  }

  return {
    home,
    port: Number(process.env.AXO_PORT) || DEFAULT_PORT,
    host: '127.0.0.1',
    nodeId: persisted.nodeId,
    token: persisted.token,
    hostname: hostname(),
    claudeBin: process.env.AXO_CLAUDE_BIN || 'claude',
    uiDir: process.env.AXO_UI_DIR || null,
    idleReapMs: Number(process.env.AXO_IDLE_REAP_MS) || 30 * 60_000,
    authMode: process.env.AXO_AUTH_MODE === 'api' ? 'api' : 'subscription',
    ...overrides,
  };
}
