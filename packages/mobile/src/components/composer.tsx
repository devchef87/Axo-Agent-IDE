import { useState } from 'react';
import { ActivityIndicator, Image, Modal, Pressable, ScrollView, View } from 'react-native';
import { Text, TextInput } from './text.tsx';
import * as Haptics from 'expo-haptics';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import type { Agent } from '@axo/protocol';
import { formatBytes, nameFor, withAttachments, type Attachment } from '../lib/attachments.ts';
import { C, HAIR } from '../theme.ts';

/**
 * Floating composer (desktop tokens: inset surface, subtle focus border, indigo Send): attach, multiline input,
 * Send; while the agent works, Stop sits next to Send and Send queues.
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
  const [focused, setFocused] = useState(false);
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

  return (
    // Floats over the chat: no panel behind it, just the card (and a small chip above it).
    <View pointerEvents="box-none" style={{ paddingHorizontal: 12, paddingTop: 6, paddingBottom: 8 }}>
      {(error || agent.queued > 0) && (
        <View style={{ alignSelf: 'flex-start', marginBottom: 6, marginLeft: 4, paddingHorizontal: 9, paddingVertical: 4, borderRadius: 4, backgroundColor: C.control, ...FLOAT }}>
          <Text style={{ color: error ? C.danger : C.secondary, fontSize: 12.5, fontWeight: '500' }} numberOfLines={2}>
            {error ?? `${agent.queued} queued`}
          </Text>
        </View>
      )}
      <View style={{ backgroundColor: C.inset, borderRadius: 10, borderWidth: 1, borderColor: focused ? C.controlHover : C.border, ...FLOAT }}>
        {files.length > 0 && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ gap: 8, paddingHorizontal: 10, paddingTop: 10 }}>
            {files.map((f) => <Chip key={f.id} file={f} onRemove={() => setFiles((cur) => cur.filter((x) => x.id !== f.id))} />)}
          </ScrollView>
        )}
        <TextInput
          value={text}
          onChangeText={setText}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder={disabled ? 'Server offline' : working ? `${agent.name} is working. Queue a follow-up…` : `Message ${agent.name}`}
          placeholderTextColor={C.dim}
          selectionColor={C.accent}
          cursorColor={C.working}
          multiline
          editable={!disabled}
          style={{ color: C.primary, fontSize: 16, lineHeight: 23, maxHeight: 168, paddingHorizontal: 14, paddingTop: 12, paddingBottom: 4, fontWeight: '500' }}
          textAlignVertical="top"
        />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 6, paddingBottom: 6 }}>
          <Pressable onPress={() => setMenu(true)} disabled={disabled || sending} accessibilityLabel="Attach photos or files" hitSlop={4}
            style={({ pressed }) => ({ height: 40, paddingHorizontal: 10, borderRadius: 4, flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: pressed ? C.hover : 'transparent', opacity: disabled ? 0.5 : 1 })}>
            <Feather name="paperclip" size={17} color={C.faint} />
            <Text style={{ color: C.faint, fontSize: 14, fontWeight: '500' }}>Attach</Text>
          </Pressable>
          <View style={{ flex: 1 }} />
          {working && (
            <Pressable onPress={stop} disabled={stopping || disabled} accessibilityLabel="Stop"
              style={({ pressed }) => ({ height: 40, paddingHorizontal: 14, borderRadius: 4, flexDirection: 'row', alignItems: 'center', gap: 7, backgroundColor: pressed ? C.danger : C.control, opacity: disabled ? 0.5 : 1 })}>
              {({ pressed }) => (<>
                {stopping ? <ActivityIndicator size="small" color={C.secondary} /> : <Feather name="square" size={14} color={pressed ? C.bg : C.secondary} />}
                <Text style={{ color: pressed ? C.bg : C.secondary, fontSize: 14, fontWeight: '500' }}>Stop</Text>
              </>)}
            </Pressable>
          )}
          <Pressable onPress={send} disabled={!canSend} accessibilityLabel={working ? 'Queue' : 'Send'}
            style={({ pressed }) => ({ height: 40, paddingHorizontal: 14, borderRadius: 4, flexDirection: 'row', alignItems: 'center', gap: 7, backgroundColor: canSend ? (pressed ? C.accentHover : C.accent) : C.control })}>
            {sending ? <ActivityIndicator size="small" color={C.accentFg} /> : <Feather name="arrow-up" size={16} color={canSend ? C.accentFg : C.faint} />}
            <Text style={{ color: canSend ? C.accentFg : C.faint, fontSize: 14, fontWeight: '500' }}>{working ? 'Queue' : 'Send'}</Text>
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
        <Image source={{ uri: file.uri }} style={{ width: 64, height: 64, borderRadius: 4, backgroundColor: C.control }} />
      ) : (
        <View style={{ width: 150, height: 64, borderRadius: 4, backgroundColor: C.control, padding: 9, justifyContent: 'center' }}>
          <Text style={{ color: C.primary, fontSize: 13 }} numberOfLines={2}>{file.name}</Text>
          {file.size != null && <Text style={{ color: C.dim, fontSize: 11.5, marginTop: 2 }}>{formatBytes(file.size)}</Text>}
        </View>
      )}
      <Pressable onPress={onRemove} hitSlop={8} accessibilityLabel={`Remove ${file.name}`}
        style={{ position: 'absolute', top: -6, right: -6, width: 22, height: 22, borderRadius: 11, backgroundColor: C.controlHover, borderWidth: HAIR, borderColor: C.border, alignItems: 'center', justifyContent: 'center' }}>
        <Feather name="x" size={13} color={C.primary} />
      </Pressable>
    </View>
  );
}

/** Bottom sheet: Photos · Camera · Files. */
function AttachMenu({ open, onClose, onPhotos, onCamera, onFiles }: { open: boolean; onClose: () => void; onPhotos: () => void; onCamera: () => void; onFiles: () => void }) {
  const insets = useSafeAreaInsets();
  const row = (label: string, hint: string, onPress: () => void) => (
    <Pressable onPress={onPress} style={({ pressed }) => ({ paddingHorizontal: 20, paddingVertical: 14, backgroundColor: pressed ? C.hover : undefined })}>
      <Text style={{ color: C.primary, fontSize: 16, fontWeight: '500' }}>{label}</Text>
      <Text style={{ color: C.dim, fontSize: 13, marginTop: 2 }}>{hint}</Text>
    </Pressable>
  );
  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable onPress={onClose} style={{ flex: 1, backgroundColor: C.overlay, justifyContent: 'flex-end' }}>
        <Pressable onPress={() => {}} style={{ backgroundColor: C.elevated, borderTopLeftRadius: 10, borderTopRightRadius: 10, paddingTop: 8, paddingBottom: 8 + insets.bottom }}>
          <View style={{ alignSelf: 'center', width: 36, height: 4, borderRadius: 2, backgroundColor: C.control, marginBottom: 6 }} />
          {row('Photos & videos', 'From your gallery', onPhotos)}
          {row('Camera', 'Take a photo or video', onCamera)}
          {row('Files', 'Documents, PDFs, anything', onFiles)}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const FLOAT = { elevation: 10, shadowColor: '#000', shadowOpacity: 0.5, shadowRadius: 14, shadowOffset: { width: 0, height: 6 } } as const;
