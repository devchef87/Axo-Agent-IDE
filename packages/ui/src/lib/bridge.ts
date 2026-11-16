// Connection discovery. In Electron the main process tells us which nodes exist
// (local + SSH-tunnelled servers). In a plain browser served by a node, we use
// that node's origin and the token from the URL hash.

import type { PreflightResult, ServerConfig, ServerInput, ServersSnapshot, SshHostEntry } from '@axo/protocol';

export interface NodeConn {
  key: string;      // stable client-side key ('local', 'prod-1', …)
  name: string;     // display name
  baseUrl: string;  // http://127.0.0.1:<port> (remote nodes: the local end of an SSH tunnel)
  token: string;
  kind?: 'local' | 'remote';
}

/** Settings → Servers. Long calls resolve when done; progress streams through onChanged. */
export interface ServersBridge {
  snapshot(): Promise<ServersSnapshot>;
  sshHosts(): Promise<SshHostEntry[]>;
  add(input: ServerInput): Promise<ServerConfig>;
  update(id: string, patch: Partial<ServerInput>): Promise<ServerConfig>;
  remove(id: string, opts?: { stopNode?: boolean }): Promise<void>;
  preflight(id: string): Promise<PreflightResult>;
  deploy(id: string): Promise<void>;
  cancelUpdate(id: string): Promise<void>;
  connect(id: string): Promise<void>;
  disconnect(id: string): Promise<void>;
  updateLocal(): Promise<void>;
  cancelLocalUpdate(): Promise<void>;
  onChanged(cb: (snap: ServersSnapshot) => void): () => void;
}

interface AxoBridge {
  getNodes(): Promise<NodeConn[]>;
  pickFolder(): Promise<string | null>;
  restartLocalNode(): Promise<void>;
  onNodesChanged(cb: (nodes: NodeConn[]) => void): () => void;
  servers?: ServersBridge;
  platform: string;
}

declare global {
  interface Window { axo?: AxoBridge }
}

export const bridge: AxoBridge | null = typeof window !== 'undefined' ? window.axo ?? null : null;
export const isElectron = !!bridge;
export const isMac = bridge ? bridge.platform === 'darwin' : /mac/i.test(navigator.platform);

export async function discoverNodes(): Promise<NodeConn[]> {
  if (bridge) return bridge.getNodes();
  const hash = new URLSearchParams(location.hash.slice(1));
  const token = hash.get('token') ?? localStorage.getItem('axo.token') ?? '';
  if (hash.get('token')) {
    localStorage.setItem('axo.token', token);
    history.replaceState(null, '', location.pathname);
  }
  const baseUrl = hash.get('node') ?? (location.port === '5199' ? 'http://127.0.0.1:31500' : location.origin);
  return [{ key: 'local', name: 'Local', baseUrl, token }];
}
