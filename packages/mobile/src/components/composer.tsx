import { useState } from 'react';
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import type { Agent } from '@axo/protocol';
import { C } from '../theme.ts';

/**
 * Multiline input with Send; while the agent works, Stop sits next to Send. Messages sent mid-turn
 * are queued by the node and go in at the next turn boundary.
 */
export function Composer({ agent, disabled, onSend, onStop }: {
  agent: Agent;
  disabled: boolean;                // node offline
  onSend: (text: string) => Promise<void>;
  onStop: () => Promise<void>;
}) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const working = agent.status === 'working' || agent.status === 'starting';
  const canSend = !!text.trim() && !sending && !disabled;

  const send = async () => {
    if (!canSend) return;
    const t = text;
    setSending(true);
    setError(null);
    try {
      await onSend(t);
      setText('');
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } catch (e: any) {
      setError(e?.message ?? 'Could not send.');
    } finally {
      setSending(false);
    }
  };

  const stop = async () => {
    setStopping(true);
    setError(null);
    try { await onStop(); void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning); }
    catch (e: any) { setError(e?.message ?? 'Could not stop.'); }
    finally { setStopping(false); }
  };

  return (
    <View style={{ paddingHorizontal: 12, paddingTop: 8, paddingBottom: 10, backgroundColor: C.panel, borderTopWidth: 1, borderTopColor: C.borderSubtle }}>
      {(agent.queued > 0 || error) && (
        <View style={{ flexDirection: 'row', gap: 10, paddingHorizontal: 4, paddingBottom: 6 }}>
          {agent.queued > 0 && <Text style={{ color: C.muted, fontSize: 12.5 }}>{agent.queued} queued · sends when {agent.name} finishes this turn</Text>}
          {error && <Text style={{ color: C.danger, fontSize: 12.5, flex: 1 }}>{error}</Text>}
        </View>
      )}
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 8 }}>
        <View style={{ flex: 1, backgroundColor: C.bg, borderRadius: 20, borderWidth: 1, borderColor: C.border, paddingHorizontal: 14, paddingVertical: 2, minHeight: 42, justifyContent: 'center' }}>
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder={disabled ? 'Server offline' : working ? `Message ${agent.name} (queued)` : `Message ${agent.name}`}
            placeholderTextColor={C.dim}
            multiline
            editable={!disabled}
            style={{ color: C.primary, fontSize: 16, lineHeight: 22, maxHeight: 160, paddingVertical: 8 }}
            textAlignVertical="center"
          />
        </View>
        {working && (
          <Pressable onPress={stop} disabled={stopping || disabled} accessibilityLabel="Stop"
            style={({ pressed }) => ({ height: 42, paddingHorizontal: 16, borderRadius: 21, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 7, borderWidth: 1, borderColor: C.danger, backgroundColor: pressed ? 'rgba(255,161,151,0.12)' : 'transparent', opacity: disabled ? 0.5 : 1 })}>
            {stopping ? <ActivityIndicator size="small" color={C.danger} /> : <View style={{ width: 11, height: 11, borderRadius: 2, backgroundColor: C.danger }} />}
            <Text style={{ color: C.danger, fontSize: 15, fontWeight: '600' }}>Stop</Text>
          </Pressable>
        )}
        <Pressable onPress={send} disabled={!canSend} accessibilityLabel="Send"
          style={({ pressed }) => ({ width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center', backgroundColor: canSend ? (pressed ? '#4cc0f0' : C.accent) : C.control })}>
          {sending ? <ActivityIndicator size="small" color={C.accentFg} /> : <Text style={{ color: canSend ? C.accentFg : C.dim, fontSize: 20, fontWeight: '700', marginTop: -2 }}>↑</Text>}
        </Pressable>
      </View>
    </View>
  );
}
