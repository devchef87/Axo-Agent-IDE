import { useEffect, useRef } from 'react';
import { Animated, BackHandler, Dimensions, Easing, Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Agent, Team } from '@axo/protocol';
import { feedKey, useAxo, type NodeView, type Selection } from '../lib/store.ts';
import { timeAgo } from '../lib/feed.ts';
import { C } from '../theme.ts';
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
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 18, paddingVertical: 14 }}>
          <Text style={{ flex: 1, color: C.primary, fontSize: 18, fontWeight: '600' }}>Axo</Text>
        </View>
        <ScrollView contentContainerStyle={{ paddingBottom: 16 }}>
          {nodeOrder.map((k) => nodes[k] && <NodeSection key={k} node={nodes[k]} onPicked={onClose} />)}
        </ScrollView>
        <Pressable onPress={onPair} style={({ pressed }) => ({ paddingHorizontal: 18, paddingVertical: 14, paddingBottom: 14 + insets.bottom, borderTopWidth: 1, borderTopColor: C.borderSubtle, backgroundColor: pressed ? C.hover : undefined })}>
          <Text style={{ color: C.muted, fontSize: 14 }}>Servers & pairing</Text>
        </Pressable>
      </Animated.View>
    </View>
  );
}

function NodeSection({ node, onPicked }: { node: NodeView; onPicked: () => void }) {
  const offline = node.status !== 'online';
  const teams = node.teams.filter((t) => !t.archivedAt);
  const projectName = (t: Team) => node.projects.find((p) => p.id === t.projectId)?.name;
  const byTeam = (t: Team) => node.agents.filter((a) => a.teamId === t.id).sort((a, b) => a.createdAt - b.createdAt);
  const showProject = new Set(teams.map((t) => t.projectId)).size > 1;
  return (
    <View style={{ marginTop: 6, opacity: offline && !node.agents.length ? 0.55 : 1 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 18, paddingTop: 10, paddingBottom: 6 }}>
        <ConnDot status={node.status} />
        <Text style={{ flex: 1, color: C.secondary, fontSize: 13, fontWeight: '600' }} numberOfLines={1}>{node.name}</Text>
        {offline && <Text style={{ color: C.dim, fontSize: 12 }}>{node.status === 'unauthorized' ? 'unpaired' : node.status === 'connecting' ? 'connecting…' : 'offline'}</Text>}
      </View>
      {node.status === 'unauthorized' && <Text style={{ color: C.dim, fontSize: 12.5, paddingHorizontal: 18, paddingBottom: 6 }}>This phone's token was revoked. Pair again from the desktop.</Text>}
      {teams.map((t) => {
        const agents = byTeam(t);
        if (!agents.length) return null;
        return (
          <View key={t.id} style={{ opacity: offline ? 0.55 : 1 }}>
            <Text style={{ color: C.dim, fontSize: 11.5, fontWeight: '600', letterSpacing: 0.5, textTransform: 'uppercase', paddingHorizontal: 18, paddingTop: 8, paddingBottom: 3 }} numberOfLines={1}>
              {showProject ? `${projectName(t)} · ${t.name}` : t.name}
            </Text>
            {agents.map((a) => <AgentRow key={a.id} nodeKey={node.key} agent={a} onPicked={onPicked} />)}
          </View>
        );
      })}
      {node.status === 'online' && !node.agents.length && <Text style={{ color: C.dim, fontSize: 13, paddingHorizontal: 18, paddingVertical: 4 }}>No agents yet.</Text>}
    </View>
  );
}

function AgentRow({ nodeKey, agent, onPicked }: { nodeKey: string; agent: Agent; onPicked: () => void }) {
  const preview = useAxo((s) => s.previews[feedKey(nodeKey, agent.id)]);
  const active = useAxo((s) => s.selected?.nodeKey === nodeKey && s.selected.agentId === agent.id);
  const select = useAxo((s) => s.select);
  const sel: Selection = { nodeKey, agentId: agent.id };
  const prefix = preview?.author === 'user' ? 'You: ' : preview?.author ? `${preview.author}: ` : '';
  return (
    <Pressable
      onPress={() => { select(sel); onPicked(); }}
      style={({ pressed }) => ({ flexDirection: 'row', gap: 10, paddingHorizontal: 18, paddingVertical: 8, backgroundColor: pressed ? C.hover : undefined })}
    >
      <View style={{ paddingTop: 7 }}><StatusDot status={agent.status} /></View>
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
          <Text style={{ flex: 1, color: active ? C.accent : C.primary, fontSize: 15, fontWeight: active ? '600' : '500' }} numberOfLines={1}>{agent.name}</Text>
          {preview && <Text style={{ color: C.dim, fontSize: 11.5 }}>{timeAgo(preview.ts)}</Text>}
        </View>
        <Text style={{ color: agent.status === 'error' ? C.danger : C.dim, fontSize: 13, lineHeight: 18 }} numberOfLines={1}>
          {agent.status === 'error' && agent.lastError ? agent.lastError : preview ? prefix + preview.text : agent.role}
        </Text>
      </View>
    </Pressable>
  );
}
