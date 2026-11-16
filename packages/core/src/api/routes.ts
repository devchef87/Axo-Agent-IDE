import { readdir } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import type { CreateAgentReq, CreateProjectReq, FsEntry, MessageReq, NodeState, UpdateAgentReq, VersionInfo } from '@axo/protocol';
import { Router } from './server.ts';
import type { Node } from '../node.ts';
import { HttpError } from '../util/http-error.ts';
import { expandHome } from '../projects.ts';
import { BUILD, VERSION } from '../config.ts';

export function buildRouter(node: Node): Router {
  const { store, bus, runtime, projects, cfg } = node;
  const r = new Router();

  r.get('/version', (): VersionInfo => ({ version: VERSION, build: BUILD, nodeId: cfg.nodeId, hostname: cfg.hostname }));

  r.get('/state', (): NodeState => ({
    nodeId: cfg.nodeId, version: VERSION, hostname: cfg.hostname, seq: bus.currentSeq, epoch: bus.epoch,
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
  r.post('/agents', ({ body }) => runtime.create(body as CreateAgentReq));
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

  return r;
}
