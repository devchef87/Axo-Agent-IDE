import { useCallback, useEffect, useState } from 'react';
import { AppState, BackHandler, Keyboard, Pressable, View } from 'react-native';
import { Text } from './src/components/text.tsx';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardProvider, KeyboardStickyView, useKeyboardState } from 'react-native-keyboard-controller';
import { feedKey, useAgent, useAxo } from './src/lib/store.ts';
import { Feed } from './src/components/feed.tsx';
import { Composer } from './src/components/composer.tsx';
import { Drawer } from './src/components/drawer.tsx';
import { PairScreen } from './src/components/pair-screen.tsx';
import { STATUS_LABEL, StatusDot } from './src/components/ui.tsx';
import { C, HAIR } from './src/theme.ts';
import { Feather } from '@expo/vector-icons';

export default function App() {
  return (
    <SafeAreaProvider>
      <KeyboardProvider>
        <StatusBar style="light" />
        <View style={{ flex: 1, backgroundColor: C.panel }}>
          <Root />
        </View>
      </KeyboardProvider>
    </SafeAreaProvider>
  );
}

function Root() {
  const ready = useAxo((s) => s.ready);
  const paired = useAxo((s) => s.paired.length > 0);
  const [settings, setSettings] = useState(false);

  useEffect(() => { void useAxo.getState().init(); }, []);
  // Phone woke or the app came back: reconnect now rather than after the backoff.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => { if (s === 'active') useAxo.getState().wake(); });
    return () => sub.remove();
  }, []);
  useEffect(() => {
    if (!settings) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { setSettings(false); return true; });
    return () => sub.remove();
  }, [settings]);

  if (!ready) return null;
  if (!paired) return <PairScreen />;
  if (settings) return <PairScreen onDone={() => setSettings(false)} />;
  return <ChatScreen onSettings={() => setSettings(true)} />;
}

function ChatScreen({ onSettings }: { onSettings: () => void }) {
  const insets = useSafeAreaInsets();
  const selected = useAxo((s) => s.selected);
  const agent = useAgent(selected);
  const node = useAxo((s) => (selected ? s.nodes[selected.nodeKey] : undefined));
  const feed = useAxo((s) => (selected ? s.feeds[feedKey(selected.nodeKey, selected.agentId)] : undefined));
  const [drawer, setDrawer] = useState(!selected);
  const [composerH, setComposerH] = useState(72);
  // Keyboard tracked natively (react-native-keyboard-controller): Android edge-to-edge never resizes the window.
  const kbHeight = useKeyboardState((k) => (k.isVisible ? k.height : 0));
  // Restored selection: load its feed once the store is up.
  useEffect(() => {
    if (selected && !feed) useAxo.getState().select(selected);
  }, [selected, feed]);

  const closeDrawer = useCallback(() => setDrawer(false), []);
  const openSettings = useCallback(() => { setDrawer(false); onSettings(); }, [onSettings]);
  const offline = node?.status !== 'online';

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <View style={{ paddingTop: insets.top, backgroundColor: C.panel, borderBottomWidth: HAIR, borderBottomColor: C.border }}>
        <View style={{ height: 54, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 6 }}>
          <Pressable onPress={() => { Keyboard.dismiss(); setDrawer(true); }} hitSlop={8} accessibilityLabel="Open menu"
            style={({ pressed }) => ({ width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: pressed ? C.hover : undefined })}>
            <Feather name="menu" size={21} color={C.secondary} />
          </Pressable>
          {agent ? (
            <View style={{ flex: 1, marginLeft: 6 }}>
              <Text style={{ color: C.primary, fontSize: 16.5, fontWeight: '500' }} numberOfLines={1}>{agent.name}</Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 1 }}>
                <StatusDot status={agent.status} size={6} />
                <Text style={{ color: C.dim, fontSize: 12.5 }} numberOfLines={1}>
                  {offline ? `${node?.name} · ${node?.status === 'connecting' ? 'reconnecting…' : 'offline'}` : `${STATUS_LABEL[agent.status]} · ${node?.name}`}
                </Text>
              </View>
            </View>
          ) : (
            <Text style={{ flex: 1, marginLeft: 6, color: C.primary, fontSize: 16.5, fontWeight: '700' }}>Axo</Text>
          )}
        </View>
      </View>

      <View style={{ flex: 1 }}>
        {agent && selected ? (
          <>
            {agent.status === 'error' && agent.lastError && (
              <View style={{ backgroundColor: 'rgba(242,139,130,0.1)', paddingHorizontal: 16, paddingVertical: 9, borderBottomWidth: HAIR, borderBottomColor: 'rgba(242,139,130,0.35)' }}>
                <Text style={{ color: C.danger, fontSize: 13 }} numberOfLines={3}>{agent.lastError}</Text>
              </View>
            )}
            <View style={{ flex: 1 }}>
              <Feed
                feed={feed ?? { items: [], drafts: {}, hasMore: false, loaded: false, loadingOlder: false }}
                agent={agent}
                nodeKey={selected.nodeKey}
                bottomInset={composerH + Math.max(0, kbHeight - insets.bottom)}
                onLoadOlder={() => void useAxo.getState().loadFeed(selected.nodeKey, selected.agentId, true)}
              />
            </View>
            {/* Floating composer: overlays the chat, which scrolls underneath it. */}
            {/* Sticks to the top of the keyboard; with it closed, sits off the bottom edge. Opened offset drops
                the nav-bar padding, which the keyboard already covers. */}
            <KeyboardStickyView offset={{ closed: 0, opened: insets.bottom + 4 }} pointerEvents="box-none"
              onLayout={(e) => setComposerH(e.nativeEvent.layout.height)}
              style={{ position: 'absolute', left: 0, right: 0, bottom: 0, paddingBottom: insets.bottom + 10 }}>
              <Composer
                agent={agent}
                disabled={offline}
                onSend={(t) => useAxo.getState().send(selected, t)}
                onStop={() => useAxo.getState().interrupt(selected)}
                onUpload={(files) => useAxo.getState().upload(selected, files)}
              />
            </KeyboardStickyView>
          </>
        ) : (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 }}>
            <Text style={{ color: C.faint, fontSize: 15, textAlign: 'center' }}>
              {selected && node?.status !== 'online' ? `Waiting for ${node?.name ?? 'the server'}…` : 'Open the menu and pick an agent.'}
            </Text>
          </View>
        )}
      </View>

      <Drawer open={drawer} onClose={closeDrawer} onPair={openSettings} />
    </View>
  );
}

