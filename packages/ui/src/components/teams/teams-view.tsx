import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ArrowDown, ArrowUp, Check, ChevronDown, ChevronRight, FileCode2, GitBranch, GitCommit, GitMerge, RefreshCw, Users } from 'lucide-react';
import type { Agent, BranchDiff, MergeRes, Team } from '@axo/protocol';
import { useAxo } from '../../stores/store.ts';
import { changeBar, parsePatch, type PatchFile } from '../../lib/patch.ts';
import { Button, cn, IconButton, StatusDot, STATUS_LABEL } from '../ui.tsx';

type Subject = { kind: 'team' } | { kind: 'agent'; agentId: string };

/** Teams: pick a team, see its members, review its branch and merge it. */
export function TeamsView() {
  const nodes = useAxo((s) => s.nodes);
  const order = useAxo((s) => s.nodeOrder);
  const sel = useAxo((s) => s.team);
  const selectTeam = useAxo((s) => s.selectTeam);

  const groups = order.flatMap((k) => nodes[k].projects.map((p) => ({
    nodeKey: k, nodeName: nodes[k].name, project: p,
    teams: nodes[k].teams.filter((t) => t.projectId === p.id && !t.archivedAt),
  }))).filter((g) => g.teams.length);
  const team = sel ? nodes[sel.nodeKey]?.teams.find((t) => t.id === sel.teamId) : undefined;

  // Default to the first team; drop a selection whose team is gone.
  useEffect(() => {
    if (team) return;
    const first = groups[0];
    if (first) selectTeam({ nodeKey: first.nodeKey, teamId: first.teams[0].id });
  }, [team, groups.length]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex h-full min-w-0 flex-1">
      <aside className="flex w-64 shrink-0 flex-col border-r border-border-subtle bg-panel">
        <div className="flex h-8 shrink-0 items-center border-b border-border-subtle px-3 text-2xs font-semibold uppercase tracking-wide text-faint">Teams</div>
        <nav className="min-h-0 flex-1 overflow-y-auto py-1" aria-label="Teams">
          {groups.length === 0 && <p className="px-3 py-4 text-xs text-faint">No teams yet. Agents you create get a team automatically.</p>}
          {groups.map((g) => (
            <div key={`${g.nodeKey}:${g.project.id}`} className="mb-1">
              <div className="truncate px-3 pb-0.5 pt-2 text-2xs font-medium text-faint">{order.length > 1 ? `${g.nodeName} / ` : ''}{g.project.name}</div>
              {g.teams.map((t) => {
                const active = sel?.nodeKey === g.nodeKey && sel.teamId === t.id;
                const members = nodes[g.nodeKey].agents.filter((a) => a.teamId === t.id);
                return (
                  <button
                    key={t.id}
                    onClick={() => selectTeam({ nodeKey: g.nodeKey, teamId: t.id })}
                    aria-current={active ? 'true' : undefined}
                    className={cn('relative flex w-full items-center gap-2 py-1.5 pl-4 pr-3 text-left text-[13px] cursor-pointer',
                      active ? 'bg-accent/12 text-primary' : 'text-secondary hover:bg-hover')}
                  >
                    {active && <span className="absolute inset-y-1 left-0 w-0.5 rounded-r bg-accent" aria-hidden />}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{t.name}</span>
                      <span className="flex items-center gap-1 truncate text-2xs text-faint">
                        {t.branch ? <><GitBranch size={9} />{t.branch}</> : t.mode}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-0.5">{members.slice(0, 4).map((a) => <StatusDot key={a.id} status={a.status} />)}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </nav>
      </aside>
      {team && sel ? <TeamDetail key={`${sel.nodeKey}:${team.id}`} nodeKey={sel.nodeKey} team={team} /> : <div className="flex-1 bg-bg" />}
    </div>
  );
}

function TeamDetail({ nodeKey, team }: { nodeKey: string; team: Team }) {
  const agents = useAxo((s) => s.nodes[nodeKey]?.agents);
  const members = useMemo(() => (agents ?? []).filter((a) => a.teamId === team.id), [agents, team.id]);
  const project = useAxo((s) => s.nodes[nodeKey]?.projects.find((p) => p.id === team.projectId));
  const select = useAxo((s) => s.select);
  const setView = useAxo((s) => s.setView);
  const [subject, setSubject] = useState<Subject>({ kind: 'team' });
  const ownWorktree = (a: Agent) => !!team.worktreePath && a.workdir !== team.worktreePath;
  const subjectAgent = subject.kind === 'agent' ? members.find((a) => a.id === subject.agentId) : undefined;

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-bg">
      <header className="shrink-0 border-b border-border-subtle px-5 py-3">
        <div className="flex items-baseline gap-2">
          <h1 className="text-[15px] font-semibold text-primary">{team.name}</h1>
          <span className="rounded bg-control px-1.5 text-2xs text-secondary">{team.mode}</span>
          {project && <span className="text-xs text-faint">{project.name}</span>}
        </div>
        {team.branch && (
          <div className="mt-0.5 flex items-center gap-1 font-mono text-2xs text-muted"><GitBranch size={10} /> {team.branch}{project?.baseBranch ? ` → ${project.baseBranch}` : ''}</div>
        )}
        <div className="mt-3 flex flex-wrap gap-1.5" aria-label="Members">
          {members.length === 0 && <span className="text-xs text-faint">No agents in this team.</span>}
          {members.map((a) => (
            <div key={a.id} className={cn('flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs',
              subject.kind === 'agent' && subject.agentId === a.id ? 'border-accent bg-accent/8' : 'border-border-subtle bg-panel')}>
              <StatusDot status={a.status} />
              <button className="text-secondary hover:text-primary cursor-pointer" title={`Open ${a.name} (${STATUS_LABEL[a.status]})`} onClick={() => { select({ nodeKey, agentId: a.id }); setView('fleet'); }}>
                {a.name}
              </button>
              <span className="text-2xs text-faint">{a.role}</span>
              {ownWorktree(a) && (
                <button
                  className="ml-1 flex items-center gap-1 rounded px-1 text-2xs text-muted hover:bg-hover hover:text-primary cursor-pointer"
                  title="This agent works in its own worktree. Review its branch and merge it into the team branch."
                  onClick={() => setSubject(subject.kind === 'agent' && subject.agentId === a.id ? { kind: 'team' } : { kind: 'agent', agentId: a.id })}
                >
                  <GitMerge size={10} /> review
                </button>
              )}
            </div>
          ))}
        </div>
      </header>
      {team.mode !== 'worktree' || !team.branch ? (
        <div className="flex flex-1 items-center justify-center p-6 text-center text-xs text-faint">
          This team works directly in the project checkout, so there's no branch to review or merge.
        </div>
      ) : (
        <Review
          key={subject.kind === 'team' ? 'team' : subject.agentId}
          nodeKey={nodeKey}
          team={team}
          agent={subjectAgent}
          onBackToTeam={subject.kind === 'agent' ? () => setSubject({ kind: 'team' }) : undefined}
        />
      )}
    </div>
  );
}

function Review({ nodeKey, team, agent, onBackToTeam }: { nodeKey: string; team: Team; agent?: Agent; onBackToTeam?: () => void }) {
  const client = useAxo((s) => s.client);
  const rev = useAxo((s) => s.teamRev[`${nodeKey}:${team.id}`] ?? 0);
  const [diff, setDiff] = useState<BranchDiff | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mergeError, setMergeError] = useState<string | null>(null);
  const [merged, setMerged] = useState<MergeRes | null>(null);
  const [busy, setBusy] = useState<'merge' | 'squash' | null>(null);
  const [loading, setLoading] = useState(false);
  const [n, setN] = useState(0);
  const filesRef = useRef<HTMLDivElement>(null);

  const url = agent ? `/agents/${agent.id}/diff` : `/teams/${team.id}/diff`;
  useEffect(() => {
    let live = true;
    setLoading(true);
    client(nodeKey).get<BranchDiff>(url).then(
      (d) => { if (live) { setDiff(d); setLoadError(null); } },
      (e: Error) => { if (live) setLoadError(e.message); },
    ).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [client, nodeKey, url, rev, n]);

  const files = useMemo(() => (diff ? parsePatch(diff.patch) : []), [diff]);

  const merge = async (strategy: 'merge' | 'squash') => {
    if (!diff) return;
    const what = agent ? `${agent.name}'s branch (${diff.branch}) into the team branch ${diff.base}` : `${diff.branch} into ${diff.base}`;
    if (!confirm(`${strategy === 'squash' ? 'Squash-merge' : 'Merge'} ${what}?`)) return;
    setBusy(strategy);
    setMergeError(null);
    setMerged(null);
    try {
      const r = await client(nodeKey).post<MergeRes>(agent ? `/agents/${agent.id}/merge-into-team` : `/teams/${team.id}/merge`, { strategy });
      setMerged(r);
      setN((x) => x + 1);
    } catch (e: any) {
      setMergeError(e.message); // the node's 409 messages are written to be shown as-is
    } finally {
      setBusy(null);
    }
  };

  if (loadError && !diff) {
    return <div className="flex flex-1 items-center justify-center p-6 text-center text-xs text-danger" role="alert">{loadError}</div>;
  }
  if (!diff) return <div className="flex flex-1 items-center justify-center text-xs text-faint">Loading branch…</div>;

  const totalAdd = diff.files.reduce((n, f) => n + f.additions, 0);
  const totalDel = diff.files.reduce((n, f) => n + f.deletions, 0);
  const nothing = diff.ahead === 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-border-subtle px-5 py-2.5">
        {onBackToTeam && <Button size="sm" variant="ghost" onClick={onBackToTeam}><Users size={11} /> Team branch</Button>}
        <div className="flex items-center gap-1.5 font-mono text-xs text-secondary">
          <GitBranch size={12} className="text-faint" /> {diff.branch} <span className="text-faint">→</span> {diff.base}
        </div>
        <div className="flex items-center gap-3 text-2xs text-muted">
          <span className="flex items-center gap-0.5" title="Commits on this branch that the base doesn't have"><ArrowUp size={10} />{diff.ahead} ahead</span>
          <span className={cn('flex items-center gap-0.5', diff.behind > 0 && 'text-warning')} title="Commits on the base this branch doesn't have"><ArrowDown size={10} />{diff.behind} behind</span>
          <span>{diff.files.length} file{diff.files.length === 1 ? '' : 's'}</span>
          <span className="text-success">+{totalAdd}</span>
          <span className="text-danger">−{totalDel}</span>
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <IconButton title="Refresh" onClick={() => setN((x) => x + 1)}><RefreshCw size={12} className={cn(loading && 'animate-spin')} /></IconButton>
          <Button size="sm" disabled={!!busy || nothing} onClick={() => void merge('squash')} title="Combine all commits into one on the base">
            {busy === 'squash' ? 'Squashing…' : 'Squash merge'}
          </Button>
          <Button size="sm" variant="primary" disabled={!!busy || nothing} onClick={() => void merge('merge')}>
            <GitMerge size={12} /> {busy === 'merge' ? 'Merging…' : agent ? 'Merge into team' : `Merge into ${diff.base}`}
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl space-y-3 px-5 py-4">
          {merged && (
            <div role="status" className="flex items-center gap-2 rounded-md bg-success/10 px-3 py-2 text-xs text-success">
              <Check size={13} /> {merged.strategy === 'squash' ? 'Squash-merged' : 'Merged'} {merged.branch} into {merged.base} as <span className="font-mono">{merged.commit.slice(0, 8)}</span>.
            </div>
          )}
          {mergeError && (
            <div role="alert" className="flex gap-2 rounded-md bg-danger/10 px-3 py-2 text-xs text-danger">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
              <pre className="whitespace-pre-wrap font-sans">{mergeError}</pre>
            </div>
          )}
          {diff.dirty.length > 0 && (
            <div className="rounded-md bg-warning/10 px-3 py-2 text-xs text-warning">
              <div className="flex items-center gap-2 font-medium"><AlertTriangle size={13} /> {diff.dirty.length} uncommitted change{diff.dirty.length === 1 ? '' : 's'} in the worktree</div>
              <p className="mt-0.5 text-2xs">These aren't part of the branch, so they won't be merged. Ask the agent to commit first.</p>
              <pre className="mt-1 max-h-24 overflow-auto font-mono text-2xs">{diff.dirty.join('\n')}</pre>
            </div>
          )}
          {nothing && !merged && <p className="py-6 text-center text-xs text-faint">Nothing to merge: {diff.branch} has no commits that {diff.base} doesn't have.</p>}

          {diff.commits.length > 0 && (
            <Section title={`${diff.commits.length}${diff.ahead > diff.commits.length ? ` of ${diff.ahead}` : ''} commit${diff.commits.length === 1 ? '' : 's'}`} icon={GitCommit} defaultOpen={diff.commits.length <= 8}>
              <ul className="divide-y divide-border-subtle">
                {diff.commits.map((c) => (
                  <li key={c.sha} className="flex gap-3 px-3 py-1.5 text-xs">
                    <span className="shrink-0 font-mono text-faint">{c.sha.slice(0, 7)}</span>
                    <span className="min-w-0 truncate text-secondary">{c.subject}</span>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {diff.files.length > 0 && (
            <Section title={`${diff.files.length} changed file${diff.files.length === 1 ? '' : 's'}`} icon={FileCode2} defaultOpen>
              <ul className="divide-y divide-border-subtle">
                {diff.files.map((f) => {
                  const [a, d] = changeBar(f.additions, f.deletions);
                  return (
                    <li key={f.path}>
                      <button
                        className="flex w-full items-center gap-3 px-3 py-1.5 text-left text-xs hover:bg-hover cursor-pointer"
                        onClick={() => filesRef.current?.querySelector(`[data-file="${CSS.escape(f.path)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                      >
                        <span className="min-w-0 flex-1 truncate font-mono text-secondary">{f.path}</span>
                        {f.binary ? <span className="text-2xs text-faint">binary</span> : (
                          <>
                            <span className="w-10 text-right font-mono text-2xs text-success">+{f.additions}</span>
                            <span className="w-10 text-right font-mono text-2xs text-danger">−{f.deletions}</span>
                            <span className="flex gap-px" aria-hidden>
                              {Array.from({ length: 5 }, (_, i) => <span key={i} className={cn('h-2 w-2 rounded-[1px]', i < a ? 'bg-success' : i < a + d ? 'bg-danger' : 'bg-control')} />)}
                            </span>
                          </>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </Section>
          )}

          <div ref={filesRef} className="space-y-3">
            {files.map((f) => <FilePatch key={f.path} file={f} defaultOpen={files.length <= 12 && f.lines.length <= 600} />)}
            {diff.truncated && <p className="text-center text-2xs text-warning">The diff was cut at 512 KB; some files aren't shown in full.</p>}
          </div>
        </div>
      </div>
    </div>
  );
}

function Section({ title, icon: Icon, defaultOpen, children }: { title: string; icon: typeof GitCommit; defaultOpen?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(!!defaultOpen);
  return (
    <section className="overflow-hidden rounded-md border border-border-subtle bg-panel">
      <button onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium text-secondary hover:bg-hover cursor-pointer">
        {open ? <ChevronDown size={12} className="text-faint" /> : <ChevronRight size={12} className="text-faint" />}
        <Icon size={12} className="text-faint" /> {title}
      </button>
      {open && <div className="border-t border-border-subtle bg-bg">{children}</div>}
    </section>
  );
}

const LINE_CLS = {
  add: 'bg-success/10',
  del: 'bg-danger/10',
  ctx: '',
  hunk: 'bg-info/8 text-info',
  note: 'text-faint italic',
} as const;

function FilePatch({ file, defaultOpen }: { file: PatchFile; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const adds = file.lines.filter((l) => l.type === 'add').length;
  const dels = file.lines.filter((l) => l.type === 'del').length;
  return (
    <section data-file={file.path} className="scroll-mt-3 overflow-hidden rounded-md border border-border-subtle">
      <button onClick={() => setOpen(!open)} aria-expanded={open}
        className="sticky top-0 z-10 flex w-full items-center gap-2 border-b border-border-subtle bg-panel px-3 py-1.5 text-left text-xs hover:bg-hover cursor-pointer">
        {open ? <ChevronDown size={12} className="text-faint" /> : <ChevronRight size={12} className="text-faint" />}
        <span className="min-w-0 flex-1 truncate font-mono text-secondary">
          {file.oldPath ? <>{file.oldPath} <span className="text-faint">→</span> </> : null}{file.path}
        </span>
        {file.status !== 'modified' && <span className="text-2xs text-faint">{file.status}</span>}
        <span className="font-mono text-2xs text-success">+{adds}</span>
        <span className="font-mono text-2xs text-danger">−{dels}</span>
      </button>
      {open && (
        file.binary ? <p className="px-3 py-2 text-2xs text-faint">Binary file</p> :
        file.lines.length === 0 ? <p className="px-3 py-2 text-2xs text-faint">No content changes</p> : (
          <div className="overflow-x-auto bg-bg">
            <table className="w-full border-collapse font-mono text-[11.5px] leading-[1.55]">
              <tbody>
                {file.lines.map((l, i) => (
                  <tr key={i} className={LINE_CLS[l.type]}>
                    <td className="w-10 select-none px-2 text-right align-top text-faint">{l.oldNo ?? ''}</td>
                    <td className="w-10 select-none px-2 text-right align-top text-faint">{l.newNo ?? ''}</td>
                    <td className={cn('w-4 select-none text-center align-top', l.type === 'add' ? 'text-success' : l.type === 'del' ? 'text-danger' : 'text-faint')}>
                      {l.type === 'add' ? '+' : l.type === 'del' ? '−' : ''}
                    </td>
                    <td className="whitespace-pre pr-4 text-primary">{l.type === 'hunk' ? <span className="text-info">{l.text}</span> : l.text || ' '}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
    </section>
  );
}
