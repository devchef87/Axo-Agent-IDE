// macOS notifications: agent finished / asked a question / errored, watch done,
// context refresh aborted. (Server disconnects are raised by the main process.)
// Suppressed while the window has focus and the agent is visible in a pane.

import { bridge, type NotifyTarget } from './bridge.ts';
import { NotifyRules } from './notify-rules.ts';
import { tapEvents, useAxo } from '../stores/store.ts';

const PREF_KEY = 'axo.notifications';
export const notificationsEnabled = () => localStorage.getItem(PREF_KEY) !== 'off';
export const setNotificationsEnabled = (on: boolean) => localStorage.setItem(PREF_KEY, on ? 'on' : 'off');

let started = false;

export function startNotifications(): void {
  if (started || !bridge?.notify) return;
  started = true;
  const rules = new NotifyRules();
  const recent = new Set<string>();

  tapEvents((nodeKey, ev) => {
    const s = useAxo.getState();
    const node = s.nodes[nodeKey];
    if (!node) return;
    const n = rules.handle(nodeKey, ev, {
      nodeName: node.name,
      agent: (id) => node.agents.find((a) => a.id === id),
      now: Date.now(),
    });
    if (!n || !notificationsEnabled() || recent.has(n.key)) return;
    const visible = n.agentId && s.layout.panes.some((p) => p?.nodeKey === nodeKey && p.agentId === n.agentId);
    if (document.hasFocus() && (visible || !n.agentId)) return;
    recent.add(n.key);
    if (recent.size > 200) recent.delete(recent.values().next().value!);
    const target: NotifyTarget = n.agentId ? { kind: 'agent', nodeKey, agentId: n.agentId } : { kind: 'servers' };
    bridge!.notify!({ title: n.title, body: n.body, target });
  });

  bridge.onServerLost?.(({ title, body }) => {
    if (notificationsEnabled() && !document.hasFocus()) bridge!.notify!({ title, body, target: { kind: 'servers' } });
  });

  bridge.onNotificationClick?.((target) => {
    const s = useAxo.getState();
    if (target.kind === 'servers') s.setUi({ servers: true });
    else if (s.nodes[target.nodeKey]?.agents.some((a) => a.id === target.agentId)) s.select({ nodeKey: target.nodeKey, agentId: target.agentId });
  });
}
