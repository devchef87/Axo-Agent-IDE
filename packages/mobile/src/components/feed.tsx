import { createContext, memo, useCallback, useContext, useMemo, useState } from 'react';
import { ActivityIndicator, Animated, FlatList, Image, Modal, Pressable, ScrollView, Text, View, type LayoutChangeEvent } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import type { Agent, FeedItem } from '@axo/protocol';
import { imageUrl, type FeedState } from '../lib/store.ts';
import { foldText, formatDuration, senderOf, toBlocks, verbOf, type Block, type ToolItem } from '../lib/feed.ts';
import { C, mono } from '../theme.ts';
import { Markdown } from './markdown.tsx';
import { REFRESH_REASON, usePulse, useTick } from './ui.tsx';

/**
 * The chat. An inverted FlatList so it opens at the newest message and stays pinned there
 * as replies stream in; scrolling up pages in older history.
 */
/** Resolves a tool-result image id to a URL on the agent's node. */
const ImageUrl = createContext<(id: string) => string | null>(() => null);

export function Feed({ feed, agent, nodeKey, onLoadOlder, bottomInset = 0 }: { feed: FeedState; agent: Agent; nodeKey: string; onLoadOlder: () => void; bottomInset?: number }) {
  const urlFor = useCallback((id: string) => imageUrl(nodeKey, agent.id, id), [nodeKey, agent.id]);
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
        <Text style={{ color: C.secondary, fontSize: 15, marginBottom: 4 }}>{agent.name} is ready.</Text>
        <Text style={{ color: C.dim, fontSize: 14 }}>Send the first instruction below.</Text>
      </View>
    );
  }
  return (
    <ImageUrl.Provider value={urlFor}>
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
    </ImageUrl.Provider>
  );
}

const BlockView = memo(function BlockView({ block, live, latest }: { block: Block; live: boolean; latest: boolean }) {
  if (block.type === 'tools') return <ToolGroup items={block.items} live={live} />;
  if (block.type === 'draft') return <View style={{ marginVertical: 4 }}><Markdown text={block.text} /></View>;
  const item = block.item;
  switch (item.kind) {
    case 'user': return <UserMessage item={item} />;
    case 'text': return <Reply text={item.text} startOpen={latest} />;
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
      <View style={{ alignItems: 'flex-end', marginTop: 18, marginBottom: 8 }}>
        <Pressable onLongPress={() => copy(item.text)} style={{ maxWidth: '84%', backgroundColor: C.control, borderRadius: 14, borderBottomRightRadius: 4, paddingHorizontal: 13, paddingVertical: 8 }}>
          <FoldedText text={item.text} color={C.primary} />
        </Pressable>
      </View>
    );
  }
  // A watch result, an Axo notice, or another agent (InnerChat): left, labelled, with a rule.
  const label = who === 'watch' ? 'Watch' : who === 'axo' ? 'Axo' : item.author;
  const rule = who === 'watch' ? C.warning : who === 'axo' ? C.dim : C.accent;
  return (
    <Pressable onLongPress={() => copy(item.text)} style={{ marginTop: 18, marginBottom: 8 }}>
      <Text style={{ color: C.dim, fontSize: 11.5, fontWeight: '600', letterSpacing: 0.4, textTransform: 'uppercase', marginBottom: 4 }}>{label}</Text>
      <View style={{ borderLeftWidth: 2, borderLeftColor: rule, paddingLeft: 10 }}>
        <FoldedText text={item.text} color={C.muted} />
      </View>
    </Pressable>
  );
}

/** Long plain text folded to its first lines with "Show all N lines". */
function FoldedText({ text, color, size = 15 }: { text: string; color: string; size?: number }) {
  const [open, setOpen] = useState(false);
  const folded = foldText(text);
  return (
    <View>
      <Text style={{ color, fontSize: size, lineHeight: size * 1.45 }}>{folded && !open ? folded.head : text}</Text>
      {folded && <Toggle open={open} onPress={() => setOpen(!open)} closed={`Show all ${folded.totalLines} lines`} />}
    </View>
  );
}

function Toggle({ open, onPress, closed, opened = 'Show less' }: { open: boolean; onPress: () => void; closed: string; opened?: string }) {
  return (
    <Pressable onPress={onPress} hitSlop={8} style={{ alignSelf: 'flex-start', marginTop: 6, paddingHorizontal: 9, paddingVertical: 4, borderRadius: 5, borderWidth: 1, borderColor: C.border }}>
      <Text style={{ color: C.muted, fontSize: 12.5 }}>{open ? `▴ ${opened}` : `▾ ${closed}`}</Text>
    </Pressable>
  );
}

const FOLD_OVER = 560;   // px of rendered reply before it folds
const FOLDED_TO = 320;

/** A finished reply. Long ones fold (measured on the rendered markdown); the latest starts open. */
function Reply({ text, startOpen }: { text: string; startOpen: boolean }) {
  const [tall, setTall] = useState(false);
  const [open, setOpen] = useState(startOpen);
  const onLayout = (e: LayoutChangeEvent) => { if (!tall && e.nativeEvent.layout.height > FOLD_OVER) setTall(true); };
  const folded = tall && !open;
  return (
    <Pressable onLongPress={() => copy(text)} style={{ marginVertical: 4 }}>
      <View style={folded ? { maxHeight: FOLDED_TO, overflow: 'hidden' } : undefined}>
        <View onLayout={onLayout}><Markdown text={text} /></View>
      </View>
      {folded && <View pointerEvents="none" style={{ height: 1, backgroundColor: C.border, marginTop: 2 }} />}
      {tall && <Toggle open={open} onPress={() => setOpen(!open)} closed="Show more" />}
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
    <View style={{ marginVertical: 3 }}>
      <Pressable onPress={() => setOpen(!open)} hitSlop={4} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 4 }}>
        <Text style={{ color: C.dim, fontSize: 11, width: 10 }}>{open ? '▾' : '▸'}</Text>
        {showLive ? (
          <>
            <ActivityIndicator size={11} color={C.working} />
            <Text style={{ color: C.muted, fontSize: 13 }}>{current.tool}</Text>
            <Text numberOfLines={1} style={{ flex: 1, color: C.dim, fontSize: 12, fontFamily: mono }}>{current.summary}</Text>
          </>
        ) : (
          <>
            <Text style={{ color: C.dim, fontSize: 13 }}>{items.length === 1 ? verbOf(current.tool) : `Ran ${items.length} tools`}</Text>
            {items.length === 1 && <Text numberOfLines={1} style={{ flex: 1, color: C.dim, fontSize: 12, fontFamily: mono }}>{current.summary}</Text>}
            {errors > 0 && <Text style={{ color: C.danger, fontSize: 13 }}>· {errors} failed</Text>}
          </>
        )}
      </Pressable>
      {/* Images stay visible even when the group is collapsed. */}
      <ImageStrip images={items.flatMap((t) => t.images ?? [])} />
      {open && (
        <View style={{ marginLeft: 4, paddingLeft: 10, borderLeftWidth: 1, borderLeftColor: C.borderSubtle }}>
          {items.map((t) => <ToolRow key={t.id} item={t} />)}
        </View>
      )}
    </View>
  );
}

/** Thumbnails of images a tool returned (screenshots etc.); tap for full size. */
function ImageStrip({ images }: { images: { id: string }[] }) {
  const urlFor = useContext(ImageUrl);
  const [open, setOpen] = useState<string | null>(null);
  if (!images.length) return null;
  const openUrl = open ? urlFor(open) : null;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingVertical: 4, paddingLeft: 16 }}>
      {images.map((img) => {
        const uri = urlFor(img.id);
        if (!uri) return null;
        return (
          <Pressable key={img.id} onPress={() => setOpen(img.id)} accessibilityLabel="Open image">
            <Image source={{ uri }} resizeMode="cover" style={{ width: 132, height: 92, borderRadius: 6, borderWidth: 1, borderColor: C.borderSubtle, backgroundColor: C.inset }} />
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
  const mark = item.status === 'running' ? '…' : item.status === 'error' ? '✕' : '✓';
  return (
    <View>
      <Pressable onPress={() => setOpen(!open)} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 5 }}>
        <Text style={{ color: C.muted, fontSize: 13 }}>{item.tool}</Text>
        <Text numberOfLines={1} style={{ flex: 1, color: C.dim, fontSize: 12, fontFamily: mono }}>{item.summary}</Text>
        {item.durationMs != null && item.durationMs > 1500 && <Text style={{ color: C.dim, fontSize: 11.5 }}>{formatDuration(item.durationMs)}</Text>}
        <Text style={{ color: item.status === 'error' ? C.danger : C.dim, fontSize: 12 }}>{mark}</Text>
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
    <View style={{ backgroundColor: C.inset, borderRadius: 5, borderWidth: 1, borderColor: error ? C.danger : C.borderSubtle, padding: 8 }}>
      <FoldedText text={text} color={error ? C.danger : C.muted} size={12} />
    </View>
  );
}

function SystemLine({ item }: { item: Extract<FeedItem, { kind: 'system' }> }) {
  const color = item.level === 'error' ? C.danger : item.level === 'warn' ? C.warning : C.dim;
  return (
    <View style={{ marginVertical: 6, paddingLeft: 10, borderLeftWidth: 2, borderLeftColor: item.level === 'info' ? 'transparent' : color }}>
      <Text style={{ color, fontSize: 13, lineHeight: 19 }}>{item.text}</Text>
    </View>
  );
}

function TurnFooter({ item }: { item: Extract<FeedItem, { kind: 'turn' }> }) {
  return (
    <View style={{ flexDirection: 'row', gap: 6, marginTop: 4, marginBottom: 10 }}>
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
      <View style={{ flex: 1, height: 1, backgroundColor: C.borderSubtle }} />
      <Text style={{ color: C.dim, fontSize: 11.5 }}>context refreshed · {REFRESH_REASON[item.reason] ?? item.reason}</Text>
      <View style={{ flex: 1, height: 1, backgroundColor: C.borderSubtle }} />
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
