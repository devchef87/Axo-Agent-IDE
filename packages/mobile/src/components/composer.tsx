import { useState } from 'react';
import { ActivityIndicator, Image, Modal, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Agent } from '@axo/protocol';
import { formatBytes, nameFor, withAttachments, type Attachment } from '../lib/attachments.ts';
import { C } from '../theme.ts';

/**
 * Floating pill: attach (+), multiline input, Send; while the agent works, Stop sits next to Send.
 * Messages sent mid-turn are queued by the node and go in at the next turn boundary.
 * Attachments upload first, then their paths are appended to the message (like the desktop).
 */
export function Composer({ agent, disabled, onSend, onStop, onUpload }: {
  agent: Agent;
  disabled: boolean;                // node offline
  onSend: (text: string) => Promise<void>;
  onStop: () => Promise<void>;
  onUpload: (files: Attachment[]) => Promise<string[]>;
}) {
  const [text, setText] = useState('');
  const [files, setFiles] = useState<Attachment[]>([]);
  const [menu, setMenu] = useState(false);
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const working = agent.status === 'working' || agent.status === 'starting';
  const canSend = (!!text.trim() || files.length > 0) && !sending && !disabled;

  const add = (picked: Attachment[]) => {
    if (!picked.length) return;
    setError(null);
    setFiles((cur) => [...cur, ...picked].slice(0, 10));
  };

  const pickMedia = async (camera: boolean) => {
    setMenu(false);
    try {
      if (camera) {
        const p = await ImagePicker.requestCameraPermissionsAsync();
        if (!p.granted) { setError('Camera access is off for Axo. Turn it on in Settings.'); return; }
      }
      const opts: ImagePicker.ImagePickerOptions = { mediaTypes: ['images', 'videos'], quality: 0.85, allowsMultipleSelection: !camera, selectionLimit: 10 };
      const r = camera ? await ImagePicker.launchCameraAsync(opts) : await ImagePicker.launchImageLibraryAsync(opts);
      if (r.canceled) return;
      add(r.assets.map((a, i) => ({
        id: `${Date.now()}-${i}`,
        uri: a.uri,
        name: a.fileName || nameFor(a.uri, a.mimeType, a.type === 'video' ? 'video' : 'photo'),
        mimeType: a.mimeType ?? null,
        size: a.fileSize ?? null,
        image: a.type !== 'video',
      })));
    } catch (e: any) { setError(e?.message ?? 'Could not open the picker.'); }
  };

  const pickFile = async () => {
    setMenu(false);
    try {
      const r = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
      if (r.canceled) return;
      add(r.assets.map((a, i) => ({
        id: `${Date.now()}-${i}`,
        uri: a.uri,
        name: a.name || nameFor(a.uri, a.mimeType),
        mimeType: a.mimeType ?? null,
        size: a.size ?? null,
        image: !!a.mimeType?.startsWith('image/'),
      })));
    } catch (e: any) { setError(e?.message ?? 'Could not open files.'); }
  };

  const send = async () => {
    if (!canSend) return;
    setSending(true);
    setError(null);
    try {
      const paths = files.length ? await onUpload(files) : [];
      await onSend(withAttachments(text.trim(), paths));
      setText('');
      setFiles([]);
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

  const notice = error ?? (agent.queued > 0 ? `${agent.queued} queued · sends when ${agent.name} finishes this turn` : null);
  return (
    // Floats over the chat: no panel behind it, just the pill (and a small notice above it).
    <View pointerEvents="box-none" style={{ paddingHorizontal: 12, paddingTop: 6, paddingBottom: 8 }}>
      {notice && (
        <View style={{ alignSelf: 'center', marginBottom: 6, paddingHorizontal: 12, paddingVertical: 5, borderRadius: 14, backgroundColor: C.elevated, borderWidth: 1, borderColor: C.border, ...FLOAT }}>
          <Text style={{ color: error ? C.danger : C.muted, fontSize: 12.5 }} numberOfLines={2}>{notice}</Text>
        </View>
      )}
      <View style={{ backgroundColor: C.elevated, borderRadius: 26, borderWidth: 1, borderColor: C.border, ...FLOAT }}>
        {files.length > 0 && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ gap: 8, paddingHorizontal: 10, paddingTop: 10 }}>
            {files.map((f) => <Chip key={f.id} file={f} onRemove={() => setFiles((cur) => cur.filter((x) => x.id !== f.id))} />)}
          </ScrollView>
        )}
        <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 4, paddingHorizontal: 5, paddingVertical: 5, minHeight: 52 }}>
          <Pressable onPress={() => setMenu(true)} disabled={disabled || sending} accessibilityLabel="Attach photos or files"
            style={({ pressed }) => ({ width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: pressed ? C.hover : 'transparent', opacity: disabled ? 0.5 : 1 })}>
            <Text style={{ color: C.muted, fontSize: 26, fontWeight: '300', marginTop: -2 }}>+</Text>
          </Pressable>
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder={disabled ? 'Server offline' : working ? `Message ${agent.name} (queued)` : `Message ${agent.name}`}
            placeholderTextColor={C.dim}
            multiline
            editable={!disabled}
            style={{ flex: 1, color: C.primary, fontSize: 16, lineHeight: 22, maxHeight: 160, paddingVertical: 8, alignSelf: 'center' }}
            textAlignVertical="center"
          />
          {working && (
            <Pressable onPress={stop} disabled={stopping || disabled} accessibilityLabel="Stop"
              style={({ pressed }) => ({ width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: pressed ? 'rgba(255,161,151,0.28)' : 'rgba(255,161,151,0.16)', opacity: disabled ? 0.5 : 1 })}>
              {stopping ? <ActivityIndicator size="small" color={C.danger} /> : <View style={{ width: 12, height: 12, borderRadius: 2.5, backgroundColor: C.danger }} />}
            </Pressable>
          )}
          <Pressable onPress={send} disabled={!canSend} accessibilityLabel="Send"
            style={({ pressed }) => ({ width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: canSend ? (pressed ? '#4cc0f0' : C.accent) : C.control })}>
            {sending ? <ActivityIndicator size="small" color={C.accentFg} /> : <Text style={{ color: canSend ? C.accentFg : C.dim, fontSize: 20, fontWeight: '700', marginTop: -2 }}>↑</Text>}
          </Pressable>
        </View>
      </View>
      <AttachMenu open={menu} onClose={() => setMenu(false)} onPhotos={() => void pickMedia(false)} onCamera={() => void pickMedia(true)} onFiles={() => void pickFile()} />
    </View>
  );
}

function Chip({ file, onRemove }: { file: Attachment; onRemove: () => void }) {
  return (
    <View style={{ position: 'relative' }}>
      {file.image ? (
        <Image source={{ uri: file.uri }} style={{ width: 64, height: 64, borderRadius: 12, backgroundColor: C.inset }} />
      ) : (
        <View style={{ width: 150, height: 64, borderRadius: 12, backgroundColor: C.inset, borderWidth: 1, borderColor: C.borderSubtle, padding: 9, justifyContent: 'center' }}>
          <Text style={{ color: C.primary, fontSize: 13 }} numberOfLines={2}>{file.name}</Text>
          {file.size != null && <Text style={{ color: C.dim, fontSize: 11.5, marginTop: 2 }}>{formatBytes(file.size)}</Text>}
        </View>
      )}
      <Pressable onPress={onRemove} hitSlop={8} accessibilityLabel={`Remove ${file.name}`}
        style={{ position: 'absolute', top: -6, right: -6, width: 22, height: 22, borderRadius: 11, backgroundColor: C.control, borderWidth: 1, borderColor: C.elevated, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ color: C.primary, fontSize: 13, marginTop: -1 }}>×</Text>
      </Pressable>
    </View>
  );
}

/** Bottom sheet: Photos · Camera · Files. */
function AttachMenu({ open, onClose, onPhotos, onCamera, onFiles }: { open: boolean; onClose: () => void; onPhotos: () => void; onCamera: () => void; onFiles: () => void }) {
  const insets = useSafeAreaInsets();
  const row = (label: string, hint: string, onPress: () => void) => (
    <Pressable onPress={onPress} style={({ pressed }) => ({ paddingHorizontal: 20, paddingVertical: 14, backgroundColor: pressed ? C.hover : undefined })}>
      <Text style={{ color: C.primary, fontSize: 16 }}>{label}</Text>
      <Text style={{ color: C.dim, fontSize: 13, marginTop: 1 }}>{hint}</Text>
    </Pressable>
  );
  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable onPress={onClose} style={{ flex: 1, backgroundColor: C.overlay, justifyContent: 'flex-end' }}>
        <Pressable onPress={() => {}} style={{ backgroundColor: C.elevated, borderTopLeftRadius: 18, borderTopRightRadius: 18, paddingTop: 8, paddingBottom: 8 + insets.bottom }}>
          <View style={{ alignSelf: 'center', width: 36, height: 4, borderRadius: 2, backgroundColor: C.control, marginBottom: 6 }} />
          {row('Photos & videos', 'From your gallery', onPhotos)}
          {row('Camera', 'Take a photo or video', onCamera)}
          {row('Files', 'Documents, PDFs, anything', onFiles)}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const FLOAT = { elevation: 8, shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 12, shadowOffset: { width: 0, height: 4 } } as const;
