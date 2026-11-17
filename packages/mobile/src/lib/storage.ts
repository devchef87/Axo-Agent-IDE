import * as SecureStore from 'expo-secure-store';
import type { PairedNode } from './pairing.ts';

// Android Keystore-backed. Keys: the paired node list (tokens) and the last agent you opened.
const NODES = 'axo.nodes.v1';
const LAST = 'axo.last.v1';

export interface Selection { nodeKey: string; agentId: string }

export async function loadNodes(): Promise<PairedNode[]> {
  try {
    const raw = await SecureStore.getItemAsync(NODES);
    return raw ? (JSON.parse(raw) as PairedNode[]) : [];
  } catch {
    return [];
  }
}

export async function saveNodes(nodes: PairedNode[]): Promise<void> {
  if (nodes.length) await SecureStore.setItemAsync(NODES, JSON.stringify(nodes));
  else await SecureStore.deleteItemAsync(NODES);
}

export async function loadLast(): Promise<Selection | null> {
  try {
    const raw = await SecureStore.getItemAsync(LAST);
    return raw ? (JSON.parse(raw) as Selection) : null;
  } catch {
    return null;
  }
}

export async function saveLast(sel: Selection | null): Promise<void> {
  if (sel) await SecureStore.setItemAsync(LAST, JSON.stringify(sel));
  else await SecureStore.deleteItemAsync(LAST);
}
