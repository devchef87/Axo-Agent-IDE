import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import type { EventEnvelope } from '@axo/protocol';
import type { NodeConfig } from '../config.ts';
import type { EventBus } from '../events.ts';
import { HttpError } from '../util/http-error.ts';

export type Handler = (ctx: { req: IncomingMessage; params: Record<string, string>; query: URLSearchParams; body: any }) => unknown | Promise<unknown>;

interface Route { method: string; re: RegExp; keys: string[]; handler: Handler }

export class Router {
  private routes: Route[] = [];
  add(method: string, path: string, handler: Handler): this {
    const keys: string[] = [];
    const re = new RegExp('^' + path.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    this.routes.push({ method, re, keys, handler });
    return this;
  }
  get(p: string, h: Handler) { return this.add('GET', p, h); }
  post(p: string, h: Handler) { return this.add('POST', p, h); }
  patch(p: string, h: Handler) { return this.add('PATCH', p, h); }
  delete(p: string, h: Handler) { return this.add('DELETE', p, h); }
  match(method: string, path: string): { handler: Handler; params: Record<string, string> } | null {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = r.re.exec(path);
      if (m) return { handler: r.handler, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
    }
    return null;
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json', '.ico': 'image/x-icon',
};

export function startServer(cfg: NodeConfig, bus: EventBus, router: Router, onHello: () => EventEnvelope): Promise<Server> {
  const tokenBuf = Buffer.from(cfg.token);
  const authed = (req: IncomingMessage, url: URL): boolean => {
    const h = req.headers.authorization;
    const given = h?.startsWith('Bearer ') ? h.slice(7) : url.searchParams.get('token') ?? '';
    const b = Buffer.from(given);
    return b.length === tokenBuf.length && timingSafeEqual(b, tokenBuf);
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    cors(res);
    if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }

    if (url.pathname === '/api/health') return json(res, 200, { ok: true });

    if (url.pathname.startsWith('/api/')) {
      if (!authed(req, url)) return json(res, 401, { error: 'unauthorized' });
      const m = router.match(req.method ?? 'GET', url.pathname.slice(4));
      if (!m) return json(res, 404, { error: 'not found' });
      try {
        const body = req.method === 'POST' || req.method === 'PATCH' ? await readJson(req) : undefined;
        const out = await m.handler({ req, params: m.params, query: url.searchParams, body });
        return json(res, 200, out ?? { ok: true });
      } catch (e: any) {
        const status = e instanceof HttpError ? e.status : 500;
        if (status === 500) console.error('[api]', req.method, url.pathname, e);
        return json(res, status, { error: e?.message ?? 'internal error' });
      }
    }

    if (cfg.uiDir && req.method === 'GET') return serveStatic(cfg.uiDir, url.pathname, res);
    json(res, 404, { error: 'not found' });
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws' || !authed(req, url)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws: WebSocket) => {
    (ws as any).isAlive = true;
    ws.on('pong', () => { (ws as any).isAlive = true; });
    ws.send(JSON.stringify(onHello()));
  });
  bus.on('event', (env: EventEnvelope) => {
    const msg = JSON.stringify(env);
    for (const c of wss.clients) if (c.readyState === 1) c.send(msg);
  });
  const ping = setInterval(() => {
    for (const c of wss.clients) {
      if (!(c as any).isAlive) { c.terminate(); continue; }
      (c as any).isAlive = false;
      c.ping();
    }
  }, 20_000);
  ping.unref();
  server.on('close', () => clearInterval(ping));

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.port, cfg.host, () => resolve(server));
  });
}

function cors(res: ServerResponse): void {
  // Token auth (header, never cookies) makes cross-origin requests safe; the UI may talk to many nodes.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
}

function json(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readJson(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 10 * 1024 * 1024) { reject(new HttpError(413, 'body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new HttpError(400, 'invalid JSON')); }
    });
    req.on('error', reject);
  });
}

async function serveStatic(root: string, pathname: string, res: ServerResponse): Promise<void> {
  const safe = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
  let file = join(root, safe);
  try {
    if (!file.startsWith(root) || !(await stat(file)).isFile()) file = join(root, 'index.html');
  } catch {
    file = join(root, 'index.html');
  }
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    json(res, 404, { error: 'not found' });
  }
}
