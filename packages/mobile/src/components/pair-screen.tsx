import { useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { parsePairing } from '../lib/pairing.ts';
import { useAxo } from '../lib/store.ts';
import { C } from '../theme.ts';
import { ConnDot } from './ui.tsx';

/** Scan the desktop's "Pair phone" QR (or paste its text). Re-pairing replaces the server list. */
export function PairScreen({ onDone }: { onDone?: () => void }) {
  const insets = useSafeAreaInsets();
  const [perm, requestPerm] = useCameraPermissions();
  const [scanning, setScanning] = useState(false);
  const [paste, setPaste] = useState(false);
  const [pasted, setPasted] = useState('');
  const [error, setError] = useState<string | null>(null);
  const handled = useRef(false);
  const paired = useAxo((s) => s.paired);
  const nodes = useAxo((s) => s.nodes);
  const pair = useAxo((s) => s.pair);
  const unpair = useAxo((s) => s.unpair);

  const accept = async (text: string) => {
    try {
      const list = parsePairing(text);
      await pair(list);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setScanning(false);
      setPaste(false);
      setError(null);
      onDone?.();
    } catch (e: any) {
      setError(e?.message ?? 'Pairing failed.');
      handled.current = false;
    }
  };

  const startScan = async () => {
    setError(null);
    if (!perm?.granted) {
      const r = await requestPerm();
      if (!r.granted) { setError('Camera access is needed to scan the code. You can paste it instead.'); return; }
    }
    handled.current = false;
    setScanning(true);
  };

  if (scanning) {
    return (
      <View style={{ flex: 1, backgroundColor: '#000' }}>
        <CameraView
          style={{ flex: 1 }}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={({ data }) => {
            if (handled.current) return;
            handled.current = true;
            void accept(data);
          }}
        />
        <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: 20, paddingBottom: 20 + insets.bottom, backgroundColor: 'rgba(0,0,0,0.55)' }}>
          <Text style={{ color: '#fff', fontSize: 15, textAlign: 'center', marginBottom: 12 }}>Point at the QR code in Axo on your computer (Settings → Pair phone).</Text>
          {error && <Text style={{ color: C.danger, fontSize: 14, textAlign: 'center', marginBottom: 12 }}>{error}</Text>}
          <Button label="Cancel" onPress={() => setScanning(false)} />
        </View>
      </View>
    );
  }

  return (
    <ScrollView style={{ flex: 1, backgroundColor: C.panel }} contentContainerStyle={{ padding: 24, paddingTop: 24 + insets.top, paddingBottom: 24 + insets.bottom }} keyboardShouldPersistTaps="handled">
      <Text style={{ color: C.primary, fontSize: 26, fontWeight: '600', marginBottom: 8 }}>{paired.length ? 'Servers' : 'Pair with Axo'}</Text>
      <Text style={{ color: C.muted, fontSize: 15, lineHeight: 22, marginBottom: 24 }}>
        {paired.length
          ? 'This phone talks to these servers over Tailscale. Pair again to replace the list.'
          : 'On your computer, open Axo → Settings → Pair phone, then scan the code. The phone connects straight to your servers over Tailscale, so keep Tailscale on here too.'}
      </Text>

      {paired.map((p) => {
        const n = nodes[p.id];
        return (
          <View key={p.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: C.borderSubtle }}>
            {n && <ConnDot status={n.status} />}
            <View style={{ flex: 1 }}>
              <Text style={{ color: C.primary, fontSize: 15 }}>{p.name}</Text>
              <Text style={{ color: C.dim, fontSize: 12.5 }}>{p.url}{n?.status && n.status !== 'online' ? ` · ${n.status === 'unauthorized' ? 'revoked' : n.error ?? n.status}` : ''}</Text>
            </View>
          </View>
        );
      })}

      <View style={{ gap: 10, marginTop: 24 }}>
        <Button label={paired.length ? 'Scan a new pairing code' : 'Scan pairing code'} primary onPress={startScan} />
        <Button label={paste ? 'Hide' : 'Paste code instead'} onPress={() => setPaste(!paste)} />
        {paste && (
          <View style={{ gap: 10 }}>
            <TextInput value={pasted} onChangeText={setPasted} multiline placeholder='{"v":1,"nodes":[…]}' placeholderTextColor={C.dim} autoCapitalize="none" autoCorrect={false}
              style={{ minHeight: 100, color: C.primary, fontFamily: 'monospace', fontSize: 13, backgroundColor: C.bg, borderRadius: 8, borderWidth: 1, borderColor: C.border, padding: 10, textAlignVertical: 'top' }} />
            <Button label="Pair" primary onPress={() => void accept(pasted)} disabled={!pasted.trim()} />
          </View>
        )}
        {error && <Text style={{ color: C.danger, fontSize: 14, lineHeight: 20 }}>{error}</Text>}
        {onDone && paired.length > 0 && <Button label="Done" onPress={onDone} />}
        {paired.length > 0 && (
          <Pressable onPress={() => Alert.alert('Forget all servers?', 'This phone will stop connecting until you pair again.', [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Forget', style: 'destructive', onPress: () => void unpair() },
          ])} style={{ paddingVertical: 14, alignItems: 'center' }}>
            <Text style={{ color: C.danger, fontSize: 14 }}>Forget all servers</Text>
          </Pressable>
        )}
      </View>
    </ScrollView>
  );
}

function Button({ label, onPress, primary, disabled }: { label: string; onPress: () => void; primary?: boolean; disabled?: boolean }) {
  return (
    <Pressable onPress={onPress} disabled={disabled}
      style={({ pressed }) => ({
        height: 48, borderRadius: 10, alignItems: 'center', justifyContent: 'center', opacity: disabled ? 0.5 : 1,
        backgroundColor: primary ? (pressed ? '#4cc0f0' : C.accent) : pressed ? C.hover : C.control,
      })}>
      <Text style={{ color: primary ? C.accentFg : C.primary, fontSize: 16, fontWeight: '600' }}>{label}</Text>
    </Pressable>
  );
}
