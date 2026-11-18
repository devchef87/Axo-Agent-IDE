import { useEffect, useRef } from 'react';
import { Animated, BackHandler, Dimensions, Easing, Pressable, ScrollView, View } from 'react-native';
import { Text } from './text.tsx';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Agent, Team } from '@axo/protocol';
import { usePreview, useAxo, type NodeView, type Selection } from '../lib/store.ts';
import { timeAgo } from '../lib/feed.ts';
import { C, HAIR } from '../theme.ts';
import { Feather } from '@expo/vector-icons';
import { ConnDot, StatusDot, useTick } from './ui.tsx';

const WIDTH = Math.min(340, Dimensions.get('window').width * 0.86);

/** Slide-in drawer: server → team → agent. Plain Animated, so it runs in Expo Go with no extra native modules. */
export function Drawer({ open, onClose, onPair }: { open: boolean; onClose: () => void; onPair: () => void }) {
  const x = useRef(new Animated.Value(open ? 0 : -WIDTH)).current;
  const insets = useSafeAreaInsets();
  const nodeOrder = useAxo((s) => s.nodeOrder);
  const nodes = useAxo((s) => s.nodes);
  const loadPreviews = useAxo((s) => s.loadPreviews);
  useTick(open, 30_000);

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
        </View>
        <ScrollView contentContainerStyle={{ paddingBottom: 16 }}>
          {nodeOrder.map((k) => nodes[k] && <NodeSection key={k} node={nodes[k]} onPicked={onClose} />)}
        </ScrollView>
        <Pressable onPress={onPair} style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 18, paddingTop: 15, paddingBottom: 15 + insets.bottom, borderTopWidth: HAIR, borderTopColor: C.border, backgroundColor: pressed ? C.hover : undefined })}>
          <Feather name="server" size={15} color={C.faint} />
          <Text style={{ color: C.faint, fontSize: 14, fontWeight: '500' }}>Servers & pairing</Text>
        </Pressable>
      </Animated.View>
    </View>
  );
}

function NodeSection({ node, onPicked }: { node: NodeView; onPicked: () => void }) {
  const offline = node.status !== 'online';
  const current = useAxo((s) => s.selected?.nodeKey === node.key);
  const teams = node.teams.filter((t) => !t.archivedAt);
  const projectName = (t: Team) => node.projects.find((p) => p.id === t.projectId)?.name;
  const byTeam = (t: Team) => node.agents.filter((a) => a.teamId === t.id).sort((a, b) => a.createdAt - b.createdAt);
  const showProject = new Set(teams.map((t) => t.projectId)).size > 1;
  return (
    <View style={{ marginTop: 6, opacity: offline && !node.agents.length ? 0.55 : 1 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 18, paddingTop: 14, paddingBottom: 6 }}>
        <ConnDot status={node.status} current={current} />
        <Text style={{ flex: 1, color: C.dim, fontSize: 11, fontWeight: '600', letterSpacing: 0.66, textTransform: 'uppercase' }} numberOfLines={1}>{node.name}</Text>
        {offline && <Text style={{ color: node.status === 'connecting' ? C.warning : C.danger, fontSize: 11.5 }}>{node.status === 'unauthorized' ? 'unpaired' : node.status === 'connecting' ? 'connecting…' : 'offline'}</Text>}
      </View>
      {node.status === 'unauthorized' && <Text style={{ color: C.dim, fontSize: 12.5, lineHeight: 18, paddingHorizontal: 18, paddingBottom: 6 }}>This phone's token was revoked. Pair again from the desktop.</Text>}
      {teams.map((t) => {
        const agents = byTeam(t);
        if (!agents.length) return null;
        return (
          <View key={t.id} style={{ opacity: offline ? 0.55 : 1 }}>
            <Text style={{ color: C.body, fontSize: 13.5, fontWeight: '500', paddingHorizontal: 18, paddingTop: 10, paddingBottom: 2 }} numberOfLines={1}>
              {showProject ? `${projectName(t)} · ${t.name}` : t.name}
            </Text>
            {agents.map((a) => <AgentRow key={a.id} nodeKey={node.key} agent={a} onPicked={onPicked} />)}
          </View>
        );
      })}
      {node.status === 'online' && !node.agents.length && <Text style={{ color: C.dim, fontSize: 13, paddingHorizontal: 18, paddingVertical: 6 }}>No agents yet.</Text>}
    </View>
  );
}

function AgentRow({ nodeKey, agent, onPicked }: { nodeKey: string; agent: Agent; onPicked: () => void }) {
  const preview = usePreview(nodeKey, agent);
  const active = useAxo((s) => s.selected?.nodeKey === nodeKey && s.selected.agentId === agent.id);
  const select = useAxo((s) => s.select);
  const sel: Selection = { nodeKey, agentId: agent.id };
  const prefix = preview?.author === 'user' ? 'You: ' : preview?.author ? `${preview.author}: ` : '';
  return (
    <Pressable
      onPress={() => { select(sel); onPicked(); }}
      style={({ pressed }) => ({ flexDirection: 'row', gap: 11, minHeight: 54, alignItems: 'center', paddingHorizontal: 18, paddingVertical: 8, backgroundColor: pressed ? C.hover : undefined })}
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
