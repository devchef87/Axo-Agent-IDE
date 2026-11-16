// Dragging an agent from the sidebar into a fleet pane. dataTransfer payloads are not
// readable during dragover, so the dragged agent also lives here to drive drop-zone UI.
import { create } from 'zustand';
import type { DragEvent } from 'react';
import type { Selection } from './layout.ts';

export const AGENT_MIME = 'application/x-axo-agent';

export const useDrag = create<{ agent: Selection | null }>(() => ({ agent: null }));

export function startAgentDrag(e: DragEvent, sel: Selection, label: string): void {
  e.dataTransfer.setData(AGENT_MIME, JSON.stringify(sel));
  e.dataTransfer.setData('text/plain', label);
  e.dataTransfer.effectAllowed = 'copyMove';
  useDrag.setState({ agent: sel });
}

export function endAgentDrag(): void {
  useDrag.setState({ agent: null });
}

export function readAgentDrop(e: DragEvent): Selection | null {
  try {
    const v = JSON.parse(e.dataTransfer.getData(AGENT_MIME));
    return typeof v?.nodeKey === 'string' && typeof v?.agentId === 'string' ? { nodeKey: v.nodeKey, agentId: v.agentId } : null;
  } catch {
    return null;
  }
}

export const isAgentDrag = (e: DragEvent) => e.dataTransfer.types.includes(AGENT_MIME);
