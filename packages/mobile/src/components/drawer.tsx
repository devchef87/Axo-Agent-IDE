import { useEffect, useRef, useState } from 'react';
import { Animated, BackHandler, Dimensions, Easing, Pressable, ScrollView, View } from 'react-native';
import { Text } from './text.tsx';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Agent, Team } from '@axo/protocol';
import { usePreview, useAxo, type NodeView, type Selection } from '../lib/store.ts';
import { confirmDeleteAgent, confirmDeleteTeam } from './actions.ts';
import { showSheet } from './dialog.tsx';
import { timeAgo } from '../lib/feed.ts';
import { C, HAIR } from '../theme.ts';
import { Feather } from '@expo/vector-icons';
import { ConnDot, StatusDot, useTick } from './ui.tsx';
import type { CreateTarget } from './create.tsx';

const WIDTH = Math.min(340, Dimensions.get('window').width * 0.86);

/** Slide-in drawer: server → team → agent. Plain Animated, so it runs in Expo Go with no extra native modules. */
export function Drawer({ open, onClose, onPair, onCreate }: { open: boolean; onClose: () => void; onPair: () => void; onCreate: (t: CreateTarget) => void }) {
  const x = useRef(new Animated.Value(open ? 0 : -WIDTH)).current;
  const insets = useSafeAreaInsets();
  const nodeOrder = useAxo((s) => s.nodeOrder);
  const nodes = useAxo((s) => s.nodes);
  const loadPreviews = useAxo((s) => s.loadPreviews);
  const selected = useAxo((s) => s.selected);
  const [menu, setMenu] = useState(false);
  // Servers and teams start collapsed every time the app opens; tap a header to open it.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const toggle = (k: string) => setExpanded((e) => ({ ...e, [k]: !e[k] }));
  useTick(open, 30_000);
  // New things default to where you are: the open agent's project and team.
  const here = (): Omit<CreateTarget, 'kind'> => {
    const a = selected ? nodes[selected.nodeKey]?.agents.find((x) => x.id === selected.agentId) : undefined;
    return a && selected ? { nodeKey: selected.nodeKey, projectId: a.projectId, teamId: a.teamId } : {};
  };

  useEffect(() => {
    Animated.timing(x, { toValue: open ? 0 : -WIDTH, duration: 200, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
    if (!open) return;
    loadPreviews();
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { onClose(); return true; });
    return () => sub.remove();
  }, [open, x, onClose, loadPreviews]);

  // Previews for a node that came online while the drawer is open.
  const online = nodeOrder.filter((k) => nodes[k]?.status === 'online').join(',');
  useEffect(() => { if (open) loadPreviews(); }, [open, online, loadPreviews]);

  const backdrop = x.interpolate({ inputRange: [-WIDTH, 0], outputRange: [0, 1] });
  return (
    <View pointerEvents={open ? 'auto' : 'none'} style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, zIndex: 10 }}>
      <Animated.View style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, backgroundColor: C.overlay, opacity: backdrop }}>
        <Pressable style={{ flex: 1 }} onPress={onClose} accessibilityLabel="Close menu" />
      </Animated.View>
      <Animated.View style={{ position: 'absolute', top: 0, bottom: 0, left: 0, width: WIDTH, backgroundColor: C.panel, transform: [{ translateX: x }], paddingTop: insets.top }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 18, height: 54 }}>
          <Text style={{ flex: 1, color: C.primary, fontSize: 18, fontWeight: '700' }}>Axo</Text>
          <Pressable onPress={() => setMenu(!menu)} hitSlop={6} accessibilityLabel="New agent or team" accessibilityState={{ expanded: menu }}
            style={({ pressed }) => ({ width: 44, height: 44, marginRight: -10, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: pressed || menu ? C.hover : undefined })}>
            <Feather name={menu ? 'x' : 'plus'} size={21} color={C.secondary} />
          </Pressable>
        </View>
        {menu && (
          <View style={{ borderBottomWidth: HAIR, borderBottomColor: C.border, paddingBottom: 6 }}>
            <MenuRow icon="user-plus" label="New agent" hint="In a team, with an optional first task"
              onPress={() => { setMenu(false); onCreate({ kind: 'agent', ...here() }); }} />
            <MenuRow icon="users" label="New team" hint="Its own branch and goal"
              onPress={() => { setMenu(false); const h = here(); onCreate({ kind: 'team', nodeKey: h.nodeKey, projectId: h.projectId }); }} />
          </View>
        )}
        <ScrollView contentContainerStyle={{ paddingBottom: 16 }}>
          {nodeOrder.map((k) => nodes[k] && <NodeSection key={k} node={nodes[k]} onPicked={onClose} onCreate={onCreate} expanded={expanded} toggle={toggle} />)}
        </ScrollView>
        <Pressable onPress={onPair} style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 18, paddingTop: 15, paddingBottom: 15 + insets.bottom, borderTopWidth: HAIR, borderTopColor: C.border, backgroundColor: pressed ? C.hover : undefined })}>
          <Feather name="server" size={15} color={C.faint} />
          <Text style={{ color: C.faint, fontSize: 14, fontWeight: '500' }}>Servers & pairing</Text>
        </Pressable>
      </Animated.View>
    </View>
  );
}

function NodeSection({ node, onPicked, onCreate, expanded, toggle }: {
  node: NodeView; onPicked: () => void; onCreate: (t: CreateTarget) => void; expanded: Record<string, boolean>; toggle: (k: string) => void;
}) {
  const offline = node.status !== 'online';
  const current = useAxo((s) => s.selected?.nodeKey === node.key);
  const open = !!expanded[`n:${node.key}`];
  const teams = node.teams.filter((t) => !t.archivedAt).sort((a, b) => a.createdAt - b.createdAt);
  const projectName = (t: Team) => node.projects.find((p) => p.id === t.projectId)?.name;
  const byTeam = (t: Team) => node.agents.filter((a) => a.teamId === t.id).sort((a, b) => a.createdAt - b.createdAt);
  const visible = node.agents.filter((a) => teams.some((t) => t.id === a.teamId));
  const showProject = new Set(teams.map((t) => t.projectId)).size > 1;
  const status = node.status === 'unauthorized' ? 'unpaired' : node.status === 'connecting' ? 'connecting…' : offline ? 'offline' : null;

  const teamActions = (t: Team) => {
    const agents = byTeam(t).length;
    showSheet([
      { label: 'New agent here', icon: 'user-plus', onPress: () => onCreate({ kind: 'agent', nodeKey: node.key, projectId: t.projectId, teamId: t.id }) },
      { label: 'Delete team', icon: 'trash-2', destructive: true, onPress: () => confirmDeleteTeam(node.key, t, agents) },
    ], t.name, agents === 1 ? '1 agent' : `${agents} agents`);
  };

  return (
    <View style={{ marginTop: 2 }}>
      <Pressable onPress={() => toggle(`n:${node.key}`)} accessibilityRole="button" accessibilityState={{ expanded: open }}
        style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 9, minHeight: 46, paddingHorizontal: 18, backgroundColor: pressed ? C.hover : undefined })}>
        <Feather name={open ? 'chevron-down' : 'chevron-right'} size={15} color={C.dim} style={{ marginLeft: -3 }} />
        <ConnDot status={node.status} current={current} />
        <Text style={{ flex: 1, color: C.dim, fontSize: 11, fontWeight: '600', letterSpacing: 0.66, textTransform: 'uppercase' }} numberOfLines={1}>{node.name}</Text>
        {status ? <Text style={{ color: node.status === 'connecting' ? C.warning : C.danger, fontSize: 11.5 }}>{status}</Text>
          : !open && <Summary agents={visible} />}
      </Pressable>
      {open && node.status === 'unauthorized' && <Text style={{ color: C.dim, fontSize: 12.5, lineHeight: 18, paddingHorizontal: 18, paddingBottom: 6 }}>This phone's token was revoked. Pair again from the desktop.</Text>}
      {open && teams.map((t) => {
        const agents = byTeam(t);
        const tOpen = !!expanded[`t:${t.id}`];
        return (
          <View key={t.id} style={{ opacity: offline ? 0.55 : 1 }}>
            <Pressable onPress={() => toggle(`t:${t.id}`)} onLongPress={offline ? undefined : () => teamActions(t)} delayLongPress={350}
              accessibilityRole="button" accessibilityState={{ expanded: tOpen }} accessibilityHint="Long-press for team actions"
              style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44, paddingLeft: 30, paddingRight: 8, backgroundColor: pressed ? C.hover : undefined })}>
              <Feather name={tOpen ? 'chevron-down' : 'chevron-right'} size={14} color={C.dim} />
              <Text style={{ flex: 1, color: C.body, fontSize: 13.5, fontWeight: '500' }} numberOfLines={1}>
                {showProject ? `${projectName(t)} · ${t.name}` : t.name}
              </Text>
              {!tOpen && <Summary agents={agents} />}
              {!offline && (
                <Pressable onPress={() => onCreate({ kind: 'agent', nodeKey: node.key, projectId: t.projectId, teamId: t.id })} hitSlop={4} accessibilityLabel={`New agent in ${t.name}`}
                  style={({ pressed }) => ({ width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: pressed ? C.control : undefined })}>
                  <Feather name="plus" size={16} color={C.dim} />
                </Pressable>
              )}
            </Pressable>
            {tOpen && agents.map((a) => <AgentRow key={a.id} nodeKey={node.key} agent={a} onPicked={onPicked} canEdit={!offline} />)}
            {tOpen && !agents.length && <Text style={{ color: C.dim, fontSize: 13, paddingLeft: 52, paddingVertical: 8 }}>No agents in this team yet.</Text>}
          </View>
        );
      })}
      {open && node.status === 'online' && !teams.length && <Text style={{ color: C.dim, fontSize: 13, paddingLeft: 42, paddingVertical: 8 }}>No teams yet.</Text>}
    </View>
  );
}

/** Right side of a collapsed header: how many agents, and a pulsing dot if any is working. */
function Summary({ agents }: { agents: Agent[] }) {
  if (!agents.length) return null;
  const working = agents.find((a) => a.status === 'working' || a.status === 'starting' || a.status === 'rotating');
  const error = agents.find((a) => a.status === 'error');
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      {(working || error) && <StatusDot status={error ? 'error' : working!.status} />}
      <Text style={{ color: C.dim, fontSize: 12 }}>{agents.length}</Text>
    </View>
  );
}

function AgentRow({ nodeKey, agent, onPicked, canEdit }: { nodeKey: string; agent: Agent; onPicked: () => void; canEdit: boolean }) {
  const preview = usePreview(nodeKey, agent);
  const active = useAxo((s) => s.selected?.nodeKey === nodeKey && s.selected.agentId === agent.id);
  const select = useAxo((s) => s.select);
  const sel: Selection = { nodeKey, agentId: agent.id };
  const prefix = preview?.author === 'user' ? 'You: ' : preview?.author ? `${preview.author}: ` : '';
  return (
    <Pressable
      onPress={() => { select(sel); onPicked(); }}
      onLongPress={canEdit ? () => showSheet([
        { label: 'Delete agent', icon: 'trash-2', destructive: true, onPress: () => confirmDeleteAgent(nodeKey, agent) },
      ], agent.name, agent.role) : undefined}
      delayLongPress={350}
      accessibilityHint="Long-press to delete"
      style={({ pressed }) => ({ flexDirection: 'row', gap: 11, minHeight: 54, alignItems: 'center', paddingLeft: 52, paddingRight: 18, paddingVertical: 8, backgroundColor: pressed ? C.hover : undefined })}
    >
      <View style={{ alignSelf: 'flex-start', paddingTop: 8 }}><StatusDot status={agent.status} /></View>
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
          <Text style={{ flex: 1, color: active ? C.accentText : C.secondary, fontSize: 15, fontWeight: active ? '500' : '400' }} numberOfLines={1}>{agent.name}</Text>
          {preview && <Text style={{ color: C.dim, fontSize: 11.5 }}>{timeAgo(preview.ts)}</Text>}
        </View>
        <Text style={{ color: agent.status === 'error' ? C.danger : C.dim, fontSize: 13, lineHeight: 18, marginTop: 1 }} numberOfLines={1}>
          {agent.status === 'error' && agent.lastError ? agent.lastError : preview ? prefix + preview.text : agent.role}
        </Text>
      </View>
    </Pressable>
  );
}

function MenuRow({ icon, label, hint, onPress }: { icon: 'user-plus' | 'users'; label: string; hint: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 18, paddingVertical: 11, backgroundColor: pressed ? C.hover : undefined })}>
      <Feather name={icon} size={18} color={C.secondary} />
      <View style={{ flex: 1 }}>
        <Text style={{ color: C.primary, fontSize: 15.5, fontWeight: '500' }}>{label}</Text>
        <Text style={{ color: C.dim, fontSize: 12.5, marginTop: 1 }}>{hint}</Text>
      </View>
    </Pressable>
  );
}
