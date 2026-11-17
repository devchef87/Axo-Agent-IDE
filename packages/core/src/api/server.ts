import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import type { EventEnvelope } from '@axo/protocol';
import type { NodeConfig } from '../config.ts';
import type { EventBus } from '../events.ts';
import { HttpError } from '../util/http-error.ts';
import { verifyAgentToken } from '../util/agent-token.ts';
import type { Terminals } from '../terminal/terminals.ts';
import type { Devices } from '../devices/devices.ts';

/** Who is calling: the node token (app/user, full access) or one agent's token (agentId set). */
/** Who is calling: the node token (app/user, full access), one agent's token (agentId), or a paired phone (deviceId). */
export interface Caller { agentId: string | null; deviceId?: string | null }

export type Handler = (ctx: { req: IncomingMessage; params: Record<string, string>; query: URLSearchParams; body: any; caller: Caller }) => unknown | Promise<unknown>;

/** Return this from a handler to send text/plain instead of JSON (the curl knock hook reads it). */
export class TextResponse {
  readonly text: string;
  constructor(text: string) { this.text = text; }
}

/** Routes an agent token may call. Everything else needs the node token. */
const AGENT_ROUTES = /^\/(version|me|knock|innerchat\/.+|watches(\/.*)?|agents\/([a-z0-9]+)\/refresh)$/;

/** What a paired phone may do (docs/MOBILE.md): read, message an agent, stop it. Nothing else. */
const DEVICE_ROUTES: [string, RegExp][] = [
  ['GET', /^\/(version|state|events)$/],
  ['GET', /^\/agents\/[a-z0-9]+\/(feed|images\/[^/]+)$/],
  ['POST', /^\/agents\/[a-z0-9]+\/(message|interrupt)$/],
];

interface Route { method: string; re: RegExp; keys: string[]; handler: Handler }

/** Return from a handler to write the response yourself (binary, streams, Range). */
export class RawResponse {
  readonly send: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
  constructor(send: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>) { this.send = send; }
}

const MAX_BODY = 10 * 1024 * 1024;
const MAX_UPLOAD_BODY = 64 * 1024 * 1024; // base64 file uploads

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
  put(p: string, h: Handler) { return this.add('PUT', p, h); }
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

export function startServer(cfg: NodeConfig, bus: EventBus, router: Router, onHello: () => EventEnvelope, terminals?: Terminals, devices?: Devices): Promise<Server> {
  const tokenBuf = Buffer.from(cfg.token);
  const given = (req: IncomingMessage, url: URL): string => {
    const h = req.headers.authorization;
    return h?.startsWith('Bearer ') ? h.slice(7) : url.searchParams.get('token') ?? '';
  };
  const authed = (req: IncomingMessage, url: URL): boolean => {
    const b = Buffer.from(given(req, url));
    return b.length === tokenBuf.length && timingSafeEqual(b, tokenBuf);
  };
  /** Caller for an /api request, or null if unauthorized. */
  const callerFor = (req: IncomingMessage, url: URL, route: string): Caller | null => {
    if (authed(req, url)) return { agentId: null };
    const deviceId = devices?.verify(given(req, url));
    if (deviceId) return DEVICE_ROUTES.some(([m, re]) => m === req.method && re.test(route)) ? { agentId: null, deviceId } : null;
    if ((req as any).axoExternal) return null; // agents are local: their tokens are never valid off-box
    const agentId = verifyAgentToken(cfg.token, given(req, url));
    if (!agentId) return null;
    const m = AGENT_ROUTES.exec(route);
    if (!m || (m[3] && m[3] !== agentId)) return null;
    return { agentId };
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    cors(res);
    if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }

    if (url.pathname === '/api/health') return json(res, 200, { ok: true });

    if (url.pathname.startsWith('/api/')) {
      const route = url.pathname.slice(4);
      const caller = callerFor(req, url, route);
      if (!caller) return json(res, 401, { error: 'unauthorized' });
      const m = router.match(req.method ?? 'GET', route);
      if (!m) return json(res, 404, { error: 'not found' });
      try {
        const limit = url.pathname.endsWith('/files/upload') ? MAX_UPLOAD_BODY : MAX_BODY;
        const body = req.method === 'POST' || req.method === 'PATCH' || req.method === 'PUT' ? await readJson(req, limit) : undefined;
        const out = await m.handler({ req, params: m.params, query: url.searchParams, body, caller });
        if (out instanceof RawResponse) return await out.send(req, res);
        if (out instanceof TextResponse) {
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
          return void res.end(out.text);
        }
        return json(res, 200, out ?? { ok: true });
      } catch (e: any) {
        const status = e instanceof HttpError ? e.status : 500;
        if (status === 500) console.error('[api]', req.method, url.pathname, e);
        if (res.headersSent) { res.destroy(); return; }
        return json(res, status, { error: e?.message ?? 'internal error' });
      }
    }

    if (cfg.uiDir && req.method === 'GET') return serveStatic(cfg.uiDir, url.pathname, res);
    json(res, 404, { error: 'not found' });
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const termWss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    // Terminals: node token only (authed() never accepts agent tokens).
    const term = /^\/ws\/term\/([A-Za-z0-9]+)$/.exec(url.pathname);
    if (term && terminals) {
      if (!authed(req, url) || (req as any).axoExternal) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
      if (!terminals.has(term[1])) { socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); socket.destroy(); return; }
      termWss.handleUpgrade(req, socket, head, (ws) => terminals.attach(term[1], ws));
      return;
    }
    const deviceId = url.pathname === '/ws' && !authed(req, url) ? devices?.verify(given(req, url)) ?? null : null;
    if (url.pathname !== '/ws' || (!authed(req, url) && !deviceId)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => { (ws as any).deviceId = deviceId; wss.emit('connection', ws, req); });
  });

  wss.on('connection', (ws: WebSocket) => {
    (ws as any).isAlive = true;
    ws.on('pong', () => { (ws as any).isAlive = true; });
    ws.send(JSON.stringify(onHello()));
  });
  devices?.on('revoked', (id: string) => {
    for (const c of wss.clients) if ((c as any).deviceId === id) c.close(4401, 'device revoked');
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
  // http.Server#close waits for every socket, and upgraded WebSockets (the app's live feed, terminals)
  // never end on their own, so a stop would hang forever. Drop them first.
  const close = server.close.bind(server);
  server.close = ((cb?: (err?: Error) => void) => {
    for (const c of [...wss.clients, ...termWss.clients]) c.terminate();
    close(cb);
    server.closeAllConnections();
    return server;
  }) as typeof server.close;

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.port, cfg.host, () => resolve(server));
  });
}

function cors(res: ServerResponse): void {
  // Token auth (header, never cookies) makes cross-origin requests safe; the UI may talk to many nodes.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Range');
  // pdf.js and <video> need these to do partial (Range) loads of raw files.
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length, Content-Encoding');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
}

function json(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readJson(req: IncomingMessage, limit = MAX_BODY): Promise<any> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'body too large')); req.destroy(); return; }
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
