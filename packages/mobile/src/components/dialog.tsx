import { Modal, Pressable, View } from 'react-native';
import { create } from 'zustand';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { Text } from './text.tsx';
import { C, HAIR } from '../theme.ts';

// Themed replacements for Android's Alert.alert, which ignores the app theme. One host (<DialogHost/> in App)
// renders whichever is open; callers use the imperative helpers below, the same shape as Alert.

export interface DialogButton { text: string; style?: 'cancel' | 'destructive' | 'default'; onPress?: () => void }
export interface SheetAction { label: string; icon?: keyof typeof Feather.glyphMap; destructive?: boolean; onPress: () => void }

type Open =
  | { kind: 'dialog'; title: string; message?: string; buttons: DialogButton[] }
  | { kind: 'sheet'; title?: string; subtitle?: string; actions: SheetAction[] };

const useDialog = create<{ open: Open | null }>(() => ({ open: null }));
const close = () => useDialog.setState({ open: null });

/** Centred confirm/notice. With no buttons it's a notice with a single OK. */
export function showDialog(title: string, message?: string, buttons: DialogButton[] = [{ text: 'OK', style: 'cancel' }]): void {
  useDialog.setState({ open: { kind: 'dialog', title, message, buttons } });
}

/** Bottom sheet of actions, like the composer's attach sheet. Cancel is the backdrop and the back button. */
export function showSheet(actions: SheetAction[], title?: string, subtitle?: string): void {
  useDialog.setState({ open: { kind: 'sheet', title, subtitle, actions } });
}

export function DialogHost() {
  const open = useDialog((s) => s.open);
  const insets = useSafeAreaInsets();
  // Close first, then run: the handler may open the next dialog (sheet → confirm → error).
  const run = (fn?: () => void) => { close(); fn?.(); };
  const cancel = () => {
    if (open?.kind === 'dialog') run(open.buttons.find((b) => b.style === 'cancel')?.onPress);
    else close();
  };

  return (
    <Modal visible={!!open} transparent animationType="fade" onRequestClose={cancel} statusBarTranslucent navigationBarTranslucent>
      {open?.kind === 'dialog' && (
        <Pressable onPress={cancel} style={{ flex: 1, backgroundColor: C.overlay, justifyContent: 'center', padding: 28 }}>
          <Pressable onPress={() => {}} accessibilityRole="alert"
            style={{ backgroundColor: C.elevated, borderRadius: 10, borderWidth: HAIR, borderColor: C.border, paddingTop: 20, paddingHorizontal: 20, paddingBottom: 12 }}>
            <Text style={{ color: C.primary, fontSize: 17, lineHeight: 23, fontWeight: '500' }}>{open.title}</Text>
            {!!open.message && <Text style={{ color: C.muted, fontSize: 14.5, lineHeight: 21, marginTop: 8 }}>{open.message}</Text>}
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
              {open.buttons.map((b) => <DialogBtn key={b.text} button={b} onPress={() => run(b.onPress)} />)}
            </View>
          </Pressable>
        </Pressable>
      )}
      {open?.kind === 'sheet' && (
        <Pressable onPress={close} style={{ flex: 1, backgroundColor: C.overlay, justifyContent: 'flex-end' }}>
          <Pressable onPress={() => {}} style={{ backgroundColor: C.elevated, borderTopLeftRadius: 10, borderTopRightRadius: 10, paddingTop: 8, paddingBottom: 8 + insets.bottom }}>
            <View style={{ alignSelf: 'center', width: 36, height: 4, borderRadius: 2, backgroundColor: C.control, marginBottom: 6 }} />
            {!!open.title && (
              <View style={{ paddingHorizontal: 20, paddingTop: 6, paddingBottom: 10 }}>
                <Text style={{ color: C.primary, fontSize: 16, fontWeight: '500' }} numberOfLines={1}>{open.title}</Text>
                {!!open.subtitle && <Text style={{ color: C.dim, fontSize: 13, marginTop: 2 }} numberOfLines={1}>{open.subtitle}</Text>}
              </View>
            )}
            {open.actions.map((a) => (
              <Pressable key={a.label} onPress={() => run(a.onPress)}
                style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 52, paddingHorizontal: 20, backgroundColor: pressed ? C.hover : undefined })}>
                {a.icon && <Feather name={a.icon} size={18} color={a.destructive ? C.danger : C.secondary} />}
                <Text style={{ color: a.destructive ? C.danger : C.primary, fontSize: 16, fontWeight: '500' }}>{a.label}</Text>
              </Pressable>
            ))}
          </Pressable>
        </Pressable>
      )}
    </Modal>
  );
}

function DialogBtn({ button, onPress }: { button: DialogButton; onPress: () => void }) {
  const danger = button.style === 'destructive';
  const quiet = button.style === 'cancel';
  return (
    <Pressable onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 40, minWidth: 72, paddingHorizontal: 16, borderRadius: 4, alignItems: 'center', justifyContent: 'center',
        backgroundColor: quiet ? (pressed ? C.hover : undefined) : danger ? (pressed ? '#d9776f' : C.danger) : pressed ? C.accentHover : C.accent,
      })}>
      <Text style={{ color: quiet ? C.secondary : danger ? '#1F2126' : C.accentFg, fontSize: 14.5, fontWeight: '500' }}>{button.text}</Text>
    </Pressable>
  );
}
