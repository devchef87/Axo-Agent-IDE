import { readdir } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import type { CreateAgentReq, CreateProjectReq, ForkReq, FsEntry, MessageReq, NodeState, ProjectContext, RefreshReq, StateDoc, UpdateAgentReq, UsageSummary, UsageTotals, VersionInfo } from '@axo/protocol';
import { RawResponse, Router } from './server.ts';
import { IMAGE_MIME } from '../runtime/images.ts';
import { createReadStream, existsSync } from 'node:fs';
import type { Node } from '../node.ts';
import { HttpError } from '../util/http-error.ts';
import { expandHome } from '../projects.ts';
import { BUILD, VERSION } from '../config.ts';
import { addCoordinationRoutes } from './coordination-routes.ts';
import { registerFileRoutes } from '../files/routes.ts';

export function buildRouter(node: Node): Router {
  const { store, bus, runtime, projects, cfg, journalist, rotator } = node;
  const r = new Router();

  r.get('/version', (): VersionInfo => ({ version: VERSION, build: BUILD, nodeId: cfg.nodeId, hostname: cfg.hostname }));

  r.get('/state', (): NodeState => ({
    nodeId: cfg.nodeId, version: VERSION, build: BUILD, hostname: cfg.hostname, seq: bus.currentSeq, epoch: bus.epoch,
    projects: store.listProjects(), teams: store.listTeams(), agents: runtime.list(),
  }));

  r.get('/events', ({ query }) => bus.since(Number(query.get('since') ?? 0), Number(query.get('epoch') ?? 0)));

  // ── projects ──
  r.post('/projects', ({ body }) => {
    const b = body as CreateProjectReq;
    if (!b?.path) throw new HttpError(400, 'path required');
    return projects.create(b.path, b.name);
  });
  r.delete('/projects/:id', async ({ params }) => {
    for (const a of runtime.list().filter((x) => x.projectId === params.id)) await runtime.remove(a.id);
    projects.remove(params.id);
  });

  // ── agents ──
  r.post('/agents', ({ body }) => node.teams.createAgent(body as CreateAgentReq)); // [core2] archived check + ownWorktree
  r.patch('/agents/:id', ({ params, body }) => runtime.update(params.id, body as UpdateAgentReq));
  r.delete('/agents/:id', ({ params }) => runtime.remove(params.id));
  r.post('/agents/:id/message', ({ params, body }) => {
    const b = body as MessageReq;
    runtime.deliver(params.id, String(b?.text ?? ''), b?.author || 'user');
  });
  r.post('/agents/:id/interrupt', ({ params }) => runtime.interrupt(params.id));
  r.post('/agents/:id/stop', ({ params }) => runtime.stop(params.id));
  r.get('/agents/:id/feed', ({ params, query }) => {
    runtime.get(params.id);
    const before = query.get('before');
    const limit = Math.min(Number(query.get('limit') ?? 200), 1000);
    return store.feedPage(params.id, before ? Number(before) : null, limit);
  });

  // ── journalist + rotation ──
  r.post('/agents/:id/refresh', ({ params, body }) => {
    // Node token, or an agent's own token (`axo rotate`; the server only lets an agent target itself). [core2]
    const b = (body ?? {}) as RefreshReq;
    runtime.get(params.id);
    if (rotator.isRotating(params.id)) throw new HttpError(409, 'a refresh is already in progress');
    const reason = b.reason === 'requested' ? 'requested' : 'manual';
    void rotator.rotate(params.id, { reason, mode: b.mode, note: b.note?.trim() || undefined }).catch(() => {});
    return { started: true };
  });
  r.post('/agents/:id/fork', ({ params, body }) => rotator.fork(params.id, (body ?? {}) as ForkReq));
  r.get('/agents/:id/state', ({ params }): StateDoc => journalist.readState(runtime.get(params.id)));
  r.post('/agents/:id/state', ({ params, body }) => {
    const text = String((body as StateDoc)?.text ?? '');
    journalist.writeStateManual(runtime.get(params.id), text);
  });
  r.get('/projects/:id/context', ({ params }): ProjectContext => {
    const p = store.getProject(params.id);
    if (!p) throw new HttpError(404, 'project not found');
    return journalist.projectContext(p);
  });
  r.post('/projects/:id/context/refresh', async ({ params }) => {
    const p = store.getProject(params.id);
    if (!p) throw new HttpError(404, 'project not found');
    await journalist.refreshMap(p);
    return journalist.projectContext(p);
  });

  registerFileRoutes(r, node);

  // ── usage + tool-result images (Axo-UI) ──
  r.get('/usage', ({ query }): UsageSummary => {
    const since = Number(query.get('since')) || Date.now() - 24 * 3600_000;
    const zero = (): UsageTotals => ({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0, costUsd: 0, turns: 0 });
    const total = zero();
    const agents: Record<string, UsageTotals> = {};
    for (const { agentId, ...u } of store.usageSince(since)) {
      agents[agentId] = u;
      for (const k of Object.keys(total) as (keyof UsageTotals)[]) total[k] += u[k];
    }
    return { since, total, agents };
  });
  r.get('/agents/:id/images/:imageId', ({ params }) => {
    const file = runtime.images.path(params.id, params.imageId);
    if (!file || !existsSync(file)) throw new HttpError(404, 'image not found');
    const type = IMAGE_MIME[params.imageId.split('.').pop()!];
    return new RawResponse((_req, res) => {
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'private, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' });
      createReadStream(file).pipe(res);
    });
  });

  // ── fs (minimal: directory picker for remote nodes; full file API arrives in phase 4) ──
  r.get('/fs/list', async ({ query }): Promise<{ path: string; parent: string | null; entries: FsEntry[] }> => {
    const path = resolve(expandHome(query.get('path') || homedir()));
    let names;
    try { names = await readdir(path, { withFileTypes: true }); } catch (e: any) { throw new HttpError(400, e.message); }
    const entries = names
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => ({ name: d.name, path: join(path, d.name), dir: true }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { path, parent: path === '/' ? null : dirname(path), entries };
  });

  addCoordinationRoutes(r, node); // [core2] teams, knock, innerchat, watches, me
  return r;
}
