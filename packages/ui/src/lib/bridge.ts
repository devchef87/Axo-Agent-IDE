// Connection discovery. In Electron the main process tells us which nodes exist
// (local + SSH-tunnelled servers). In a plain browser served by a node, we use
// that node's origin and the token from the URL hash.

export interface NodeConn {
  key: string;      // stable client-side key ('local', 'prod-1', …)
  name: string;     // display name
  baseUrl: string;  // http://127.0.0.1:<port>
  token: string;
}

interface AxoBridge {
  getNodes(): Promise<NodeConn[]>;
  pickFolder(): Promise<string | null>;
  restartLocalNode(): Promise<void>;
  onNodesChanged(cb: (nodes: NodeConn[]) => void): () => void;
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
