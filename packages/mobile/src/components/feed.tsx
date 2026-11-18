import { createContext, memo, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { ActivityIndicator, Animated, FlatList, Image, Modal, Pressable, ScrollView, View, type LayoutChangeEvent } from 'react-native';
import { Text } from './text.tsx';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import type { Agent, FeedItem } from '@axo/protocol';
import { imageUrl, type FeedState } from '../lib/store.ts';
import { foldText, formatDuration, senderOf, timeAgo, toBlocks, verbOf, type Block, type ToolItem } from '../lib/feed.ts';
import { C, HAIR, mono, TYPE } from '../theme.ts';
import { Feather } from '@expo/vector-icons';
import { Markdown } from './markdown.tsx';
import { REFRESH_REASON, usePulse, useTick } from './ui.tsx';

/**
 * The chat. An inverted FlatList so it opens at the newest message and stays pinned there
 * as replies stream in; scrolling up pages in older history.
 */
/** What blocks need from the open chat: the agent's name/role for reply headers, and tool-image URLs. */
interface FeedCtx { name: string; role: string; urlFor: (id: string) => string | null }
const Ctx = createContext<FeedCtx>({ name: '', role: '', urlFor: () => null });

export function Feed({ feed, agent, nodeKey, onLoadOlder, bottomInset = 0 }: { feed: FeedState; agent: Agent; nodeKey: string; onLoadOlder: () => void; bottomInset?: number }) {
  const ctx = useMemo<FeedCtx>(() => ({ name: agent.name, role: agent.role, urlFor: (id) => imageUrl(nodeKey, agent.id, id) }), [nodeKey, agent.id, agent.name, agent.role]);
  const blocks = useMemo(() => toBlocks(feed.items, feed.drafts), [feed.items, feed.drafts]);
  const data = useMemo(() => blocks.slice().reverse(), [blocks]);
  const working = agent.status === 'working' || agent.status === 'starting';
  const latestText = useMemo(() => blocks.findLast((b) => b.type === 'item' && b.item.kind === 'text')?.id, [blocks]);

  const render = useCallback(({ item, index }: { item: Block; index: number }) => (
    <BlockView block={item} live={working && index < 2} latest={item.id === latestText} />
  ), [working, latestText]);

  if (!feed.loaded) {
    return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}><ActivityIndicator color={C.dim} /></View>;
  }
  if (!blocks.length && !working) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, paddingBottom: 32 + bottomInset }}>
        <Text style={{ color: C.primary, fontSize: 16, fontWeight: '500', marginBottom: 4 }}>{agent.name} is ready.</Text>
        <Text style={{ color: C.dim, fontSize: 14 }}>Send the first instruction below.</Text>
      </View>
    );
  }
  return (
    <Ctx.Provider value={ctx}>
    <FlatList
      inverted
      data={data}
      keyExtractor={(b) => b.id}
      renderItem={render}
      contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 12 }}
      // Inverted: the header sits at the bottom. Room for the floating composer, so the last message clears it.
      ListHeaderComponent={<>{working && <Working agent={agent} last={blocks.at(-1)} />}<View style={{ height: bottomInset }} /></>}
      ListFooterComponent={feed.loadingOlder ? <ActivityIndicator color={C.dim} style={{ marginVertical: 12 }} /> : undefined}
      onEndReached={feed.hasMore ? onLoadOlder : undefined}
      onEndReachedThreshold={0.5}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      initialNumToRender={12}
      maxToRenderPerBatch={8}
      windowSize={9}
    />
    </Ctx.Provider>
  );
}

const BlockView = memo(function BlockView({ block, live, latest }: { block: Block; live: boolean; latest: boolean }) {
  if (block.type === 'tools') return <ToolGroup items={block.items} live={live} />;
  if (block.type === 'draft') return <AgentMessage><Markdown text={block.text} /></AgentMessage>;
  const item = block.item;
  switch (item.kind) {
    case 'user': return <UserMessage item={item} />;
    case 'text': return <AgentMessage ts={item.ts} copyText={item.text}><Reply text={item.text} startOpen={latest} /></AgentMessage>;
    case 'system': return <SystemLine item={item} />;
    case 'turn': return <TurnFooter item={item} />;
    case 'rotation': return <RotationDivider item={item} />;
    default: return null;
  }
});

function copy(text: string) {
  void Clipboard.setStringAsync(text);
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
}

function UserMessage({ item }: { item: Extract<FeedItem, { kind: 'user' }> }) {
  const who = senderOf(item.author);
  if (who === 'you') {
    // Yours: a bubble on the right, so the conversation doesn't read as one wall of text.
    return (
      <View style={{ alignItems: 'flex-end', marginTop: 22, marginBottom: 10 }}>
        <Pressable onLongPress={() => copy(item.text)} style={{ maxWidth: '82%', backgroundColor: C.control, borderRadius: 8, borderBottomRightRadius: 3, paddingHorizontal: 14, paddingVertical: 9 }}>
          <FoldedText text={item.text} color={C.primary} size={TYPE.bubble} weight="500" />
        </Pressable>
      </View>
    );
  }
  // A watch result, an Axo notice, or another agent (InnerChat): left, labelled, with a rule.
  const label = who === 'watch' ? 'Watch' : who === 'axo' ? 'Axo' : item.author;
  const rule = who === 'watch' ? C.warning : C.borderStrong;
  return (
    <Pressable onLongPress={() => copy(item.text)} style={{ marginTop: 22, marginBottom: 10 }}>
      <Text style={{ color: C.faint, fontSize: 11, fontWeight: '600', letterSpacing: 0.66, textTransform: 'uppercase', marginBottom: 5 }}>{label}</Text>
      <View style={{ borderLeftWidth: HAIR, borderLeftColor: rule, paddingLeft: 12 }}>
        <FoldedText text={item.text} color={C.secondary} size={14.5} />
      </View>
    </Pressable>
  );
}

/** Long plain text folded to its first lines with "Show all N lines". */
function FoldedText({ text, color, size = 15, weight, mono: isMono }: { text: string; color: string; size?: number; weight?: '500'; mono?: boolean }) {
  const [open, setOpen] = useState(false);
  const folded = foldText(text);
  return (
    <View>
      <Text style={{ color, fontSize: size, lineHeight: Math.round(size * (isMono ? 1.5 : 1.6)), fontWeight: weight, letterSpacing: isMono ? 0 : size * 0.01, fontFamily: isMono ? mono : undefined }}>{folded && !open ? folded.head : text}</Text>
      {folded && <Toggle open={open} onPress={() => setOpen(!open)} closed={`Show all ${folded.totalLines} lines`} />}
    </View>
  );
}

function Toggle({ open, onPress, closed, opened = 'Show less' }: { open: boolean; onPress: () => void; closed: string; opened?: string }) {
  return (
    <Pressable onPress={onPress} hitSlop={10} style={({ pressed }) => ({ alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 8, paddingHorizontal: 9, height: 30, borderRadius: 4, borderWidth: 1, borderColor: C.border, backgroundColor: pressed ? C.hover : 'transparent' })}>
      <Feather name={open ? 'chevron-up' : 'chevron-down'} size={13} color={C.secondary} />
      <Text style={{ color: C.secondary, fontSize: 12.5, fontWeight: '500' }}>{open ? opened : closed}</Text>
    </Pressable>
  );
}

const FOLD_OVER = 520;   // px of rendered reply before it folds (desktop 440 at 14.5px; scaled to 16)
const FOLDED_TO = 300;

/** A finished reply. Long ones fold (measured on the rendered markdown); the latest starts open. */
function Reply({ text, startOpen }: { text: string; startOpen: boolean }) {
  const [tall, setTall] = useState(false);
  const [open, setOpen] = useState(startOpen);
  const onLayout = (e: LayoutChangeEvent) => { if (!tall && e.nativeEvent.layout.height > FOLD_OVER) setTall(true); };
  const folded = tall && !open;
  return (
    <View>
      <View style={folded ? { maxHeight: FOLDED_TO, overflow: 'hidden' } : undefined}>
        <View onLayout={onLayout}><Markdown text={text} /></View>
      </View>
      {folded && <Fade />}
      {tall && <Toggle open={open} onPress={() => setOpen(!open)} closed="Show more" />}
    </View>
  );
}

/** Bottom fade on a folded reply: stacked bands of the body colour (no gradient library needed). */
function Fade() {
  return (
    <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, bottom: 38, height: 56 }}>
      {[0.0, 0.15, 0.3, 0.45, 0.6, 0.72, 0.84, 0.94].map((o, i) => (
        <View key={i} style={{ flex: 1, backgroundColor: C.bg, opacity: o }} />
      ))}
    </View>
  );
}

/** An agent reply: name, role and time above; the text set off by a hairline indigo rule (tool calls stay outside it). */
function AgentMessage({ ts, copyText, children }: { ts?: number; copyText?: string; children: ReactNode }) {
  const { name, role } = useContext(Ctx);
  useTick(!!ts, 30_000);
  return (
    <Pressable onLongPress={copyText ? () => copy(copyText) : undefined} style={{ marginTop: 20, marginBottom: 10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8, marginBottom: 7 }}>
        <Text style={{ color: C.primary, fontSize: 13.5, fontWeight: '500' }} numberOfLines={1}>{name}</Text>
        {!!role && <Text style={{ color: C.dim, fontSize: 12, flexShrink: 1 }} numberOfLines={1}>{role}</Text>}
        {!!ts && ts > 1e12 && <Text style={{ marginLeft: 'auto', color: C.dim, fontSize: 11.5 }}>{timeAgo(ts)}</Text>}
      </View>
      <View style={{ borderLeftWidth: HAIR, borderLeftColor: 'rgba(84,70,250,0.6)', paddingLeft: 16 }}>{children}</View>
    </Pressable>
  );
}

/** Consecutive tool calls on one line. While live: the current call; when done: "Ran 6 tools". */
function ToolGroup({ items, live }: { items: ToolItem[]; live: boolean }) {
  const [open, setOpen] = useState(false);
  const running = items.filter((t) => t.status === 'running');
  const errors = items.filter((t) => t.status === 'error').length;
  const current = running.at(-1) ?? items.at(-1)!;
  const showLive = live && running.length > 0;
  return (
    <View style={{ marginVertical: 2 }}>
      <Pressable onPress={() => setOpen(!open)} style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 7, minHeight: 36, marginLeft: -6, paddingHorizontal: 6, borderRadius: 4, backgroundColor: pressed ? C.hover : 'transparent' })}>
        <Feather name={open ? 'chevron-down' : 'chevron-right'} size={14} color={C.faint} />
        {showLive ? (
          <>
            <ActivityIndicator size={12} color={C.working} />
            <Text style={{ color: C.muted, fontSize: 12.5, fontFamily: mono }}>{current.tool}</Text>
            <Text numberOfLines={1} style={{ flex: 1, color: C.faint, fontSize: 12, fontFamily: mono }}>{current.summary}</Text>
          </>
        ) : (
          <>
            <Text style={{ color: C.faint, fontSize: 12.5, fontFamily: mono }}>{items.length === 1 ? verbOf(current.tool) : `${items.length} tool calls`}</Text>
            {items.length === 1 && <Text numberOfLines={1} style={{ flex: 1, color: C.faint, fontSize: 12, fontFamily: mono }}>{current.summary}</Text>}
            {errors > 0 && <Text style={{ color: C.danger, fontSize: 12.5, fontFamily: mono }}>· {errors} failed</Text>}
          </>
        )}
      </Pressable>
      {/* Images stay visible even when the group is collapsed. */}
      <ImageStrip images={items.flatMap((t) => t.images ?? [])} />
      {open && (
        <View style={{ marginLeft: 6, paddingLeft: 10, borderLeftWidth: HAIR, borderLeftColor: C.border }}>
          {items.map((t) => <ToolRow key={t.id} item={t} />)}
        </View>
      )}
    </View>
  );
}

/** Thumbnails of images a tool returned (screenshots etc.); tap for full size. */
function ImageStrip({ images }: { images: { id: string }[] }) {
  const { urlFor } = useContext(Ctx);
  const [open, setOpen] = useState<string | null>(null);
  if (!images.length) return null;
  const openUrl = open ? urlFor(open) : null;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingVertical: 4, paddingLeft: 20 }}>
      {images.map((img) => {
        const uri = urlFor(img.id);
        if (!uri) return null;
        return (
          <Pressable key={img.id} onPress={() => setOpen(img.id)} accessibilityLabel="Open image">
            <Image source={{ uri }} resizeMode="cover" style={{ width: 132, height: 92, borderRadius: 4, borderWidth: HAIR, borderColor: C.border, backgroundColor: C.inset }} />
          </Pressable>
        );
      })}
      <Modal visible={!!openUrl} transparent animationType="fade" onRequestClose={() => setOpen(null)}>
        <Pressable onPress={() => setOpen(null)} style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.92)', justifyContent: 'center' }}>
          {openUrl && <Image source={{ uri: openUrl }} resizeMode="contain" style={{ width: '100%', height: '85%' }} />}
        </Pressable>
      </Modal>
    </ScrollView>
  );
}

function ToolRow({ item }: { item: ToolItem }) {
  const [open, setOpen] = useState(false);
  return (
    <View>
      <Pressable onPress={() => setOpen(!open)} style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 7, minHeight: 36, paddingHorizontal: 4, borderRadius: 4, backgroundColor: pressed ? C.hover : 'transparent' })}>
        <Text style={{ color: C.muted, fontSize: 12.5, fontFamily: mono }}>{item.tool}</Text>
        <Text numberOfLines={1} style={{ flex: 1, color: C.faint, fontSize: 12, fontFamily: mono }}>{item.summary}</Text>
        {item.durationMs != null && item.durationMs > 1500 && <Text style={{ color: C.dim, fontSize: 11.5, fontFamily: mono }}>{formatDuration(item.durationMs)}</Text>}
        {item.status === 'running' ? <ActivityIndicator size={11} color={C.working} />
          : <Feather name={item.status === 'error' ? 'alert-circle' : 'check'} size={13} color={item.status === 'error' ? C.danger : C.dim} />}
      </Pressable>
      {open && <ToolDetail item={item} />}
    </View>
  );
}

function ToolDetail({ item }: { item: ToolItem }) {
  const i = item.input as Record<string, any>;
  let input: string;
  if (item.tool === 'Bash') input = `$ ${i.command}`;
  else if (item.tool === 'Edit' && typeof i.old_string === 'string') input = `- ${i.old_string}\n+ ${i.new_string ?? ''}`;
  else if (item.tool === 'Write' && typeof i.content === 'string') input = i.content;
  else input = JSON.stringify(i, null, 2);
  return (
    <View style={{ gap: 6, marginBottom: 8 }}>
      <Pre text={input} />
      {!!item.result && item.tool !== 'Read' && <Pre text={item.result} error={item.status === 'error'} />}
    </View>
  );
}

function Pre({ text, error }: { text: string; error?: boolean }) {
  return (
    <View style={{ backgroundColor: C.inset, borderRadius: 3, borderWidth: HAIR, borderColor: error ? C.danger : C.border, paddingHorizontal: 10, paddingVertical: 8 }}>
      <FoldedText text={text} color={error ? C.danger : C.muted} size={12} mono />
    </View>
  );
}

function SystemLine({ item }: { item: Extract<FeedItem, { kind: 'system' }> }) {
  const color = item.level === 'error' ? C.danger : item.level === 'warn' ? C.warning : C.dim;
  return (
    <View style={{ marginVertical: 6, paddingLeft: 12, borderLeftWidth: HAIR, borderLeftColor: item.level === 'info' ? 'transparent' : color }}>
      <Text style={{ color, fontSize: 13, lineHeight: 20 }}>{item.text}</Text>
    </View>
  );
}

function TurnFooter({ item }: { item: Extract<FeedItem, { kind: 'turn' }> }) {
  return (
    <View style={{ flexDirection: 'row', gap: 6, marginTop: 6, marginBottom: 12, paddingLeft: 17 }}>
      <Text style={{ color: C.dim, fontSize: 11.5, fontFamily: mono }}>{formatDuration(item.durationMs)}</Text>
      {item.costUsd > 0 && <Text style={{ color: C.dim, fontSize: 11.5, fontFamily: mono }}>· ${item.costUsd.toFixed(2)}</Text>}
      {item.interrupted && <Text style={{ color: C.warning, fontSize: 11.5, fontFamily: mono }}>· stopped</Text>}
      {item.isError && <Text style={{ color: C.danger, fontSize: 11.5, fontFamily: mono }}>· ended with error</Text>}
    </View>
  );
}

/** Context refresh. Deliberately quiet. */
function RotationDivider({ item }: { item: Extract<FeedItem, { kind: 'rotation' }> }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginVertical: 14 }}>
      <View style={{ flex: 1, height: HAIR, backgroundColor: C.border }} />
      <Text style={{ color: C.dim, fontSize: 11.5 }}>context refreshed · {REFRESH_REASON[item.reason] ?? item.reason}</Text>
      <View style={{ flex: 1, height: HAIR, backgroundColor: C.border }} />
    </View>
  );
}

function Dot({ delay }: { delay: number }) {
  const opacity = usePulse(true, delay);
  return <Animated.View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: C.working, opacity }} />;
}

function Working({ agent, last }: { agent: Agent; last: Block | undefined }) {
  useTick(true);
  if (last?.type === 'draft') return null;
  if (last?.type === 'tools' && last.items.some((t) => t.status === 'running')) return null;
  const elapsed = Date.now() - agent.lastActiveAt;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginVertical: 8 }}>
      <View style={{ flexDirection: 'row', gap: 4 }}>{[0, 200, 400].map((d) => <Dot key={d} delay={d} />)}</View>
      <Text style={{ color: C.dim, fontSize: 13 }}>{agent.status === 'starting' ? 'Starting…' : 'Thinking…'}</Text>
      {elapsed > 3000 && <Text style={{ color: C.dim, fontSize: 13 }}>{formatDuration(Math.round(elapsed / 1000) * 1000)}</Text>}
    </View>
  );
}
