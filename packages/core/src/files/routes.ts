import type { CreateFileReq, RenameFileReq, UploadReq, WriteFileReq } from '@axo/protocol';
import type { Router } from '../api/server.ts';
import { RawResponse } from '../api/server.ts';
import type { Node } from '../node.ts';
import { HttpError } from '../util/http-error.ts';
import * as F from './files.ts';

/** /projects/:id/files/* — the editor's file API. `?team=` targets a team worktree, `?agent=` an agent's own worktree. */
export function registerFileRoutes(r: Router, node: Node): void {
  const { store, bus } = node;

  const rootFor = (projectId: string, query: URLSearchParams): string => {
    const p = store.getProject(projectId);
    if (!p) throw new HttpError(404, 'project not found');
    const agentId = query.get('agent');
    if (agentId) {
      // An agent's own worktree (per-agent branch), or wherever it works.
      const a = store.getAgent(agentId);
      if (!a || a.projectId !== p.id) throw new HttpError(404, 'agent not found');
      return a.workdir;
    }
    const teamId = query.get('team');
    if (!teamId) return p.path;
    const t = store.getTeam(teamId);
    if (!t || t.projectId !== p.id) throw new HttpError(404, 'team not found');
    return t.worktreePath ?? p.path;
  };
  const changed = (projectId: string, root: string, paths: string[]) => bus.publish({ type: 'files:changed', projectId, root, paths });
  const q = (query: URLSearchParams, k: string) => query.get(k) ?? '';

  const base = '/projects/:id/files';
  // Lease live files:changed for this root (renew every minute while viewing; expires after 5).
  r.post(`${base}/watch`, ({ params, query }) => node.fileWatcher.lease(rootFor(params.id, query), params.id));
  r.get(`${base}/tree`, ({ params, query }) => F.tree(rootFor(params.id, query), q(query, 'path')));
  r.get(`${base}/read`, ({ params, query }) => F.read(rootFor(params.id, query), q(query, 'path')));
  r.get(`${base}/raw`, ({ params, query }) => {
    const root = rootFor(params.id, query);
    return new RawResponse((req, res) => F.sendRaw(root, q(query, 'path'), req, res, query.get('download') === '1'));
  });
  r.get(`${base}/search`, ({ params, query }) => F.search(rootFor(params.id, query), q(query, 'q'), Number(query.get('limit')) || 50));
  r.get(`${base}/git-status`, ({ params, query }) => F.gitStatus(rootFor(params.id, query)));
  r.get(`${base}/diff`, ({ params, query }) => F.diff(rootFor(params.id, query), query.get('path') || undefined));
  r.get(`${base}/original`, ({ params, query }) => F.original(rootFor(params.id, query), q(query, 'path')));

  r.post(`${base}/write`, async ({ params, query, body }) => {
    const b = (body ?? {}) as WriteFileReq;
    const root = rootFor(params.id, query);
    const out = await F.write(root, b.path, b.content, typeof b.baseMtime === 'number' ? b.baseMtime : undefined);
    changed(params.id, root, [out.path]);
    return out;
  });
  r.post(`${base}/create`, async ({ params, query, body }) => {
    const b = (body ?? {}) as CreateFileReq;
    const root = rootFor(params.id, query);
    const out = await F.create(root, b.path, !!b.dir, b.content);
    changed(params.id, root, [out.path]);
    return out;
  });
  r.post(`${base}/rename`, async ({ params, query, body }) => {
    const b = (body ?? {}) as RenameFileReq;
    const root = rootFor(params.id, query);
    const out = await F.renamePath(root, b.from, b.to);
    changed(params.id, root, [out.from, out.to]);
    return out;
  });
  r.post(`${base}/upload`, async ({ params, query, body }) => {
    const b = (body ?? {}) as UploadReq;
    const root = rootFor(params.id, query);
    const out = await F.upload(root, b.dir ?? '', b.files);
    changed(params.id, root, out.uploaded.map((u) => u.path));
    return out;
  });
  r.delete(base, async ({ params, query }) => {
    const root = rootFor(params.id, query);
    const out = await F.remove(root, q(query, 'path'));
    changed(params.id, root, [out.path]);
    return out;
  });
}
