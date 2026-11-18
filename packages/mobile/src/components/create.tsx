import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ActivityIndicator, BackHandler, Modal, Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import type { TeamMode } from '@axo/protocol';
import { useAxo, type Selection } from '../lib/store.ts';
import { C, HAIR } from '../theme.ts';
import { Text, TextInput } from './text.tsx';

// New team / new agent, the phone versions of the desktop's dialogs (packages/ui/src/components/dialogs.tsx):
// same fields, same requests (POST /teams, POST /agents), laid out as full-screen sheets with tap targets.

const ROLES = ['fullstack', 'backend', 'frontend', 'devops', 'testing', 'research', 'docs'];
const MODELS = [{ id: 'opus', label: 'Opus' }, { id: 'sonnet', label: 'Sonnet' }, { id: 'haiku', label: 'Haiku' }];
const TEAM_MODES: { mode: TeamMode; label: string; hint: string }[] = [
  { mode: 'worktree', label: 'Own branch', hint: 'Its own worktree on branch axo/<team>; merge when done.' },
  { mode: 'shared', label: 'Main checkout', hint: 'Works directly in the project folder.' },
];

/** What the sheet opens with: where to create, and (for agents) which team. */
export interface CreateTarget { kind: 'agent' | 'team'; nodeKey?: string; projectId?: string; teamId?: string }

/** Projects on servers that are online, as "server|project" choices. */
function useProjects() {
  const nodes = useAxo((s) => s.nodes);
  const nodeOrder = useAxo((s) => s.nodeOrder);
  return useMemo(() => {
    const online = nodeOrder.filter((k) => nodes[k]?.status === 'online');
    return online.flatMap((k) => nodes[k].projects.map((p) => ({
      value: `${k}|${p.id}`, nodeKey: k, project: p, label: online.length > 1 ? `${nodes[k].name} / ${p.name}` : p.name,
    })));
  }, [nodes, nodeOrder]);
}

export function CreateSheet({ target, onClose, onCreatedAgent }: {
  target: CreateTarget | null;
  onClose: () => void;
  onCreatedAgent: (sel: Selection) => void;
}) {
  const [step, setStep] = useState<CreateTarget | null>(target);
  useEffect(() => setStep(target), [target]);
  useEffect(() => {
    if (!step) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { onClose(); return true; });
    return () => sub.remove();
  }, [step, onClose]);
  return (
    <Modal visible={!!step} animationType="slide" onRequestClose={onClose} statusBarTranslucent navigationBarTranslucent>
      {step?.kind === 'team' && <NewTeam key="team" target={step} onClose={onClose} onNext={(t) => setStep(t)} />}
      {step?.kind === 'agent' && <NewAgent key={`agent-${step.teamId ?? ''}`} target={step} onClose={onClose} onCreated={onCreatedAgent} />}
    </Modal>
  );
}

function NewAgent({ target, onClose, onCreated }: { target: CreateTarget; onClose: () => void; onCreated: (sel: Selection) => void }) {
  const projects = useProjects();
  const nodes = useAxo((s) => s.nodes);
  const createAgent = useAxo((s) => s.createAgent);
  const first = projects.find((p) => p.nodeKey === target.nodeKey && p.project.id === target.projectId) ?? projects[0];
  const [dest, setDest] = useState(first?.value ?? '');
  const [teamId, setTeamId] = useState(target.teamId ?? '');
  const [name, setName] = useState('');
  const [role, setRole] = useState('fullstack');
  const [model, setModel] = useState('opus');
  const [task, setTask] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [nodeKey, projectId] = dest.split('|');
  const teams = (nodes[nodeKey]?.teams ?? []).filter((t) => t.projectId === projectId && !t.archivedAt).sort((a, b) => a.createdAt - b.createdAt);
  // Every agent belongs to a team: the one you started from, else the project's first.
  const team = teams.find((t) => t.id === teamId) ?? teams[0];

  const submit = async () => {
    if (!nodeKey || !projectId || busy) return;
    setBusy(true);
    setError(null);
    try {
      const agent = await createAgent(nodeKey, { projectId, teamId: team?.id, name: name.trim() || undefined, role, model, task: task.trim() || undefined });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onClose();
      onCreated({ nodeKey, agentId: agent.id });
    } catch (e: any) {
      setError(e?.message ?? 'Could not create the agent.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet title="New agent" onClose={onClose} action={busy ? 'Creating…' : 'Create agent'} busy={busy} disabled={!projects.length} onAction={submit} error={error}>
      {!projects.length ? <Empty /> : (
        <>
          <Field label="Name" hint="Optional, defaults to role-N">
            <Input value={name} onChangeText={setName} placeholder={`${role}-1`} autoCapitalize="none" autoCorrect={false} />
          </Field>
          <Field label="Role">
            <Chips options={ROLES.map((r) => ({ value: r, label: r }))} value={role} onChange={setRole} />
          </Field>
          {projects.length > 1 && (
            <Field label="Project">
              <Chips options={projects.map((p) => ({ value: p.value, label: p.label }))} value={dest} onChange={(v) => { setDest(v); setTeamId(''); }} />
            </Field>
          )}
          <Field label="Team" hint={teams.length ? undefined : 'No teams in this project yet; the node puts the agent in its default team.'}>
            {teams.length > 0 && <Chips options={teams.map((t) => ({ value: t.id, label: t.name }))} value={team?.id ?? ''} onChange={setTeamId} />}
          </Field>
          <Field label="Model">
            <Chips options={MODELS.map((m) => ({ value: m.id, label: m.label }))} value={model} onChange={setModel} />
          </Field>
          <Field label="Task" hint="Optional, sent as the first message">
            <Input value={task} onChangeText={setTask} placeholder="What should this agent work on?" multiline style={{ minHeight: 120, textAlignVertical: 'top', paddingTop: 12 }} />
          </Field>
        </>
      )}
    </Sheet>
  );
}

function NewTeam({ target, onClose, onNext }: { target: CreateTarget; onClose: () => void; onNext: (next: CreateTarget) => void }) {
  const projects = useProjects();
  const createTeam = useAxo((s) => s.createTeam);
  const first = projects.find((p) => p.nodeKey === target.nodeKey && p.project.id === target.projectId) ?? projects[0];
  const [dest, setDest] = useState(first?.value ?? '');
  const [name, setName] = useState('');
  const [mode, setMode] = useState<TeamMode>('worktree');
  const [base, setBase] = useState('');
  const [goal, setGoal] = useState('');
  const [addAgent, setAddAgent] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chosen = projects.find((p) => p.value === dest);
  const project = chosen?.project;
  const git = !!project?.isGit;

  const submit = async () => {
    if (!chosen || !project || busy) return;
    if (!name.trim()) { setError('Give the team a name.'); return; }
    setBusy(true);
    setError(null);
    try {
      const team = await createTeam(chosen.nodeKey, {
        projectId: project.id, name: name.trim(), mode: git ? mode : 'direct',
        base: git && mode === 'worktree' && base.trim() ? base.trim() : undefined,
        goal: goal.trim() || undefined,
      });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      if (addAgent) onNext({ kind: 'agent', nodeKey: chosen.nodeKey, projectId: project.id, teamId: team.id });
      else onClose();
    } catch (e: any) {
      const m = String(e?.message ?? '');
      setError(/already exists/i.test(m) ? 'A team with that name already exists in this project.'
        : /team name/i.test(m) ? 'Use up to 40 letters, numbers, spaces, . _ or -.' : m || 'Could not create the team.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet title="New team" onClose={onClose} action={busy ? 'Creating…' : addAgent ? 'Create, then add agent' : 'Create team'} busy={busy} disabled={!projects.length} onAction={submit} error={error}>
      {!projects.length ? <Empty /> : (
        <>
          <Field label="Name">
            <Input value={name} onChangeText={setName} placeholder="e.g. payments" maxLength={40} autoCorrect={false} />
          </Field>
          {projects.length > 1 && (
            <Field label="Project">
              <Chips options={projects.map((p) => ({ value: p.value, label: p.label }))} value={dest} onChange={setDest} />
            </Field>
          )}
          {git ? (
            <Field label="Where it works">
              <View style={{ gap: 8 }}>
                {TEAM_MODES.map((m) => (
                  <Pressable key={m.mode} onPress={() => setMode(m.mode)} accessibilityRole="radio" accessibilityState={{ checked: mode === m.mode }}
                    style={({ pressed }) => ({ padding: 12, borderRadius: 4, borderWidth: 1, borderColor: mode === m.mode ? C.controlHover : C.border, backgroundColor: mode === m.mode ? C.control : pressed ? C.hover : 'transparent' })}>
                    <Text style={{ color: C.primary, fontSize: 15, fontWeight: '500' }}>{m.label}</Text>
                    <Text style={{ color: C.faint, fontSize: 13, lineHeight: 18, marginTop: 2 }}>{m.hint}</Text>
                  </Pressable>
                ))}
              </View>
            </Field>
          ) : project && (
            <Text style={{ color: C.faint, fontSize: 13.5, lineHeight: 20, marginBottom: 18 }}>{project.name} isn't a git repository, so the team works directly in the project folder.</Text>
          )}
          {git && mode === 'worktree' && (
            <Field label="Branch from" hint={`Optional, defaults to ${project?.baseBranch ?? 'the current branch'}`}>
              <Input value={base} onChangeText={setBase} placeholder={project?.baseBranch ?? 'HEAD'} autoCapitalize="none" autoCorrect={false} />
            </Field>
          )}
          <Field label="Goal" hint="Optional, what this team is for. Its agents read it.">
            <Input value={goal} onChangeText={setGoal} placeholder="e.g. Ship Stripe checkout" multiline style={{ minHeight: 96, textAlignVertical: 'top', paddingTop: 12 }} />
          </Field>
          <Pressable onPress={() => setAddAgent(!addAgent)} accessibilityRole="checkbox" accessibilityState={{ checked: addAgent }}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44 }}>
            <View style={{ width: 20, height: 20, borderRadius: 4, borderWidth: 1, borderColor: addAgent ? C.accent : C.borderStrong, backgroundColor: addAgent ? C.accent : 'transparent', alignItems: 'center', justifyContent: 'center' }}>
              {addAgent && <Feather name="check" size={14} color={C.accentFg} />}
            </View>
            <Text style={{ color: C.secondary, fontSize: 15 }}>Add an agent to it next</Text>
          </Pressable>
        </>
      )}
    </Sheet>
  );
}

function Sheet({ title, onClose, action, onAction, busy, disabled, error, children }: {
  title: string; onClose: () => void; action: string; onAction: () => void; busy: boolean; disabled?: boolean; error: string | null; children: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <View style={{ paddingTop: insets.top, borderBottomWidth: HAIR, borderBottomColor: C.borderSubtle }}>
        <View style={{ height: 58, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 6 }}>
          <Pressable onPress={onClose} hitSlop={8} accessibilityLabel="Close"
            style={({ pressed }) => ({ width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: pressed ? C.hover : undefined })}>
            <Feather name="x" size={21} color={C.secondary} />
          </Pressable>
          <Text style={{ flex: 1, marginLeft: 6, color: C.primary, fontSize: 16.5, lineHeight: 21, fontWeight: '500' }}>{title}</Text>
        </View>
      </View>
      <KeyboardAwareScrollView bottomOffset={96} keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 18, paddingBottom: 40 }}>
        {children}
        {error && <Text style={{ color: C.danger, fontSize: 14, lineHeight: 20, marginTop: 4 }}>{error}</Text>}
      </KeyboardAwareScrollView>
      <View style={{ paddingHorizontal: 18, paddingTop: 10, paddingBottom: 12 + insets.bottom, borderTopWidth: HAIR, borderTopColor: C.borderSubtle }}>
        <Pressable onPress={onAction} disabled={busy || disabled}
          style={({ pressed }) => ({ height: 48, borderRadius: 4, flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: 'center', opacity: disabled ? 0.5 : 1, backgroundColor: pressed ? C.accentHover : C.accent })}>
          {busy && <ActivityIndicator size="small" color={C.accentFg} />}
          <Text style={{ color: C.accentFg, fontSize: 15.5, fontWeight: '500' }}>{action}</Text>
        </Pressable>
      </View>
    </View>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children?: ReactNode }) {
  return (
    <View style={{ marginBottom: 20 }}>
      <Text style={{ color: C.faint, fontSize: 11, fontWeight: '600', letterSpacing: 0.66, textTransform: 'uppercase', marginBottom: 8 }}>{label}</Text>
      {children}
      {hint && <Text style={{ color: C.dim, fontSize: 12.5, lineHeight: 17, marginTop: 6 }}>{hint}</Text>}
    </View>
  );
}

function Input(props: React.ComponentProps<typeof TextInput>) {
  const [focused, setFocused] = useState(false);
  return (
    <TextInput
      placeholderTextColor={C.dim}
      selectionColor={C.accent}
      cursorColor={C.working}
      {...props}
      onFocus={(e) => { setFocused(true); props.onFocus?.(e); }}
      onBlur={(e) => { setFocused(false); props.onBlur?.(e); }}
      style={[{ minHeight: 48, paddingHorizontal: 14, color: C.primary, fontSize: 16, fontWeight: '500', backgroundColor: C.inset, borderRadius: 4, borderWidth: 1, borderColor: focused ? C.controlHover : C.border }, props.style]}
    />
  );
}

function Chips({ options, value, onChange }: { options: { value: string; label: string }[]; value: string; onChange: (v: string) => void }) {
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable key={o.value} onPress={() => onChange(o.value)} accessibilityRole="radio" accessibilityState={{ checked: on }}
            style={({ pressed }) => ({ minHeight: 40, paddingHorizontal: 14, justifyContent: 'center', borderRadius: 4, borderWidth: 1, borderColor: on ? C.controlHover : C.border, backgroundColor: on ? C.control : pressed ? C.hover : 'transparent' })}>
            <Text style={{ color: on ? C.primary : C.secondary, fontSize: 14.5, fontWeight: on ? '500' : '400' }}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function Empty() {
  return <Text style={{ color: C.faint, fontSize: 15, lineHeight: 22 }}>No server is online right now. Connect to one to create teams and agents.</Text>;
}
