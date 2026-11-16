import type {
  ArchiveTeamReq, AskReq, MergeReq, RelayAckReq, RelayInReq, CreateTeamReq, CreateWatchReq, KnockReq, KnockRes, MeRes, TellReq, UpdateProjectReq, UpdateTeamReq,
} from '@axo/protocol';
import { TextResponse, type Caller, type Router } from './server.ts';
import type { Node } from '../node.ts';
import { HttpError } from '../util/http-error.ts';
import { decide, toolPaths } from '../teams/scope.ts';

/** Phase 2 routes: teams, knock, InnerChat, watches, and `GET /me` for the axo CLI. */
export function addCoordinationRoutes(r: Router, node: Node): void {
  const { store, bus, runtime, teams, watches, innerchat } = node;

  /** The acting agent: the token's agent, or (node token only) an explicit id/name in the body. */
  const actingAgent = (caller: Caller, explicit?: unknown): string => {
    if (caller.agentId) return runtime.get(caller.agentId).id;
    if (typeof explicit !== 'string' || !explicit) throw new HttpError(400, 'from/agentId required with the node token');
    const a = runtime.list().find((x) => x.id === explicit) ?? runtime.list().find((x) => x.name === explicit);
    if (!a) throw new HttpError(404, `agent not found: ${explicit}`);
    return a.id;
  };

  // ── projects / teams ──
  r.patch('/projects/:id', ({ params, body }) => teams.updateProject(params.id, body as UpdateProjectReq));
  r.post('/teams', ({ body }) => teams.create(body as CreateTeamReq));
  r.patch('/teams/:id', ({ params, body }) => {
    const b = body as UpdateTeamReq;
    return b?.name !== undefined ? teams.rename(params.id, String(b.name)) : teams.get(params.id);
  });
  r.post('/teams/:id/archive', ({ params, body }) => teams.archive(params.id, body as ArchiveTeamReq));
  r.get('/teams/:id/diff', ({ params }) => teams.diff(params.id));
  r.post('/teams/:id/merge', ({ params, body }) => teams.merge(params.id, (body as MergeReq)?.strategy ?? 'merge'));
  r.get('/agents/:id/diff', ({ params }) => teams.agentDiff(params.id));
  r.post('/agents/:id/merge-into-team', ({ params, body }) => teams.mergeAgent(params.id, (body as MergeReq)?.strategy ?? 'merge'));

  // ── knock (PreToolUse hook) ──
  r.post('/knock', ({ body, query, caller }) => {
    const b = (body ?? {}) as KnockReq & { agentId?: string };
    let res: KnockRes = { allow: true };
    const agentId = caller.agentId ?? b.agentId;
    const agent = agentId ? store.getAgent(agentId) : null;
    if (agent) {
      const others = runtime.list().filter((a) => a.id !== agent.id && !store.getTeam(a.teamId)?.archivedAt);
      res = decide(agent, others, toolPaths(b.tool_input), b.cwd);
      if (!res.allow) {
        bus.publish({ type: 'knock:denied', agentId: agent.id, agentName: agent.name, tool: String(b.tool_name ?? ''),
          path: res.path ?? '', owner: res.owner ?? null, reason: res.reason ?? '' });
      }
    }
    if (query.get('format') === 'text') return new TextResponse(res.allow ? 'ALLOW' : `DENY ${res.reason}`);
    return res;
  });

  // ── InnerChat ──
  r.get('/innerchat/who', ({ caller, query }) => innerchat.who(caller.agentId, query.get('projectId') ?? undefined));
  r.post('/innerchat/ask', ({ body, caller, req }) => {
    const b = body as AskReq & { from?: string };
    const from = actingAgent(caller, b?.from);
    return innerchat.ask(from, String(b?.to ?? ''), String(b?.message ?? ''), b?.timeoutMs, (cancel) => {
      // The CLI was killed (e.g. Bash timeout): stop blocking, deliver the answer later as a message.
      req.socket.once('close', cancel);
    });
  });
  r.post('/innerchat/tell', ({ body, caller }) => {
    const b = body as TellReq & { from?: string };
    return innerchat.tell(actingAgent(caller, b?.from), String(b?.to ?? ''), String(b?.message ?? ''));
  });
  r.get('/innerchat/threads', ({ caller, query }) => innerchat.threads(caller.agentId ?? query.get('agentId') ?? undefined));
  r.get('/innerchat/threads/:id', ({ params, caller }) => {
    const turns = innerchat.turns(params.id);
    if (caller.agentId && !turns.some((t) => t.fromId === caller.agentId || t.toId === caller.agentId)) {
      throw new HttpError(404, 'thread not found');
    }
    return turns;
  });

  // Cross-server relay: only the app (node token) may read the outbox or inject envelopes.
  const appOnly = (caller: Caller) => { if (caller.agentId) throw new HttpError(403, 'relay routes need the node token'); };
  r.get('/innerchat/outbox', ({ caller }) => { appOnly(caller); return innerchat.outbox(); });
  r.post('/innerchat/outbox/:id/ack', ({ params, body, caller }) => {
    appOnly(caller);
    const b = (body ?? {}) as RelayAckReq;
    innerchat.ack(params.id, !!b.ok, b.error);
  });
  r.post('/innerchat/relay-in', ({ body, caller }) => {
    appOnly(caller);
    const b = (body ?? {}) as RelayInReq;
    return innerchat.relayIn(b.envelope, String(b.fromServer ?? ''));
  });

  // ── watches ──
  r.get('/watches', ({ caller, query }) => watches.list({
    agentId: caller.agentId ?? query.get('agentId'), teamId: caller.agentId ? null : query.get('teamId'),
  }));
  r.post('/watches', ({ body, caller }) => {
    const b = (body ?? {}) as CreateWatchReq;
    return watches.create({ ...b, agentId: actingAgent(caller, b.agentId) });
  });
  r.get('/watches/:id', ({ params, caller }) => {
    const w = watches.get(params.id);
    if (caller.agentId && w.agentId !== caller.agentId) throw new HttpError(404, 'watch not found');
    return w;
  });
  r.get('/watches/:id/output', ({ params, query, caller }) => {
    const w = watches.get(params.id);
    if (caller.agentId && w.agentId !== caller.agentId) throw new HttpError(404, 'watch not found');
    return { output: watches.output(params.id, Number(query.get('bytes')) || undefined) };
  });
  r.post('/watches/:id/cancel', ({ params, caller }) => watches.cancel(params.id, caller.agentId));
  r.post('/watches/:id/rerun', ({ params, caller }) => watches.rerun(params.id, caller.agentId));

  // ── me (axo status) ──
  r.get('/me', ({ caller, query }): MeRes => {
    const agent = runtime.get(actingAgent(caller, query.get('agentId') ?? undefined));
    const team = store.getTeam(agent.teamId)!;
    const project = store.getProject(agent.projectId)!;
    const teammates = innerchat.who(agent.id).agents.filter((a) => !a.you);
    return { agent, team, project, watches: watches.list({ agentId: agent.id }).filter((w) => w.status === 'active'), teammates };
  });
}
