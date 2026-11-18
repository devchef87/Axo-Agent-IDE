import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, View, type TextProps } from 'react-native';
import { Text } from './text.tsx';
import type { AgentStatus } from '@axo/protocol';
import type { ConnStatus } from '../lib/client.ts';
import { C, HAIR } from '../theme.ts';

export const STATUS_LABEL: Record<AgentStatus, string> = {
  working: 'working', starting: 'starting', rotating: 'refreshing', idle: 'idle',
  asleep: 'asleep', stopped: 'stopped', error: 'error',
};

export const REFRESH_REASON: Record<string, string> = {
  manual: 'refreshed by you', context: 'context was filling up', ceiling: 'session hit its token ceiling',
  velocity: 'context was growing fast', degraded: 'responses were degrading', requested: 'the agent asked for it',
};

export const isLive = (s: AgentStatus) => s === 'working' || s === 'starting' || s === 'rotating';

/** A pulsing opacity loop while `active`. */
export function usePulse(active: boolean, delay = 0): Animated.Value {
  const v = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!active) { v.setValue(1); return; }
    const loop = Animated.loop(Animated.sequence([
      Animated.delay(delay),
      Animated.timing(v, { toValue: 0.35, duration: 700, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      Animated.timing(v, { toValue: 1, duration: 700, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [active, delay, v]);
  return v;
}

/** Agent status: working pulses indigo, idle grey, asleep/stopped barely there, error red. Solid dots only. */
export function StatusDot({ status, size = 6 }: { status: AgentStatus; size?: number }) {
  const live = isLive(status);
  const opacity = usePulse(live);
  const color = status === 'error' ? C.danger
    : status === 'rotating' ? C.muted
    : live ? C.working
    : status === 'idle' ? C.dim
    : C.dotSoft;
  return <Animated.View style={{ width: size, height: size, borderRadius: size / 2, opacity, backgroundColor: color }} />;
}

/** Server: indigo for the one you're working in, soft for the others, amber pulsing while connecting, red offline. */
export function ConnDot({ status, current = false }: { status: ConnStatus; current?: boolean }) {
  const opacity = usePulse(status === 'connecting');
  const color = status === 'online' ? (current ? C.working : C.dotSoft) : status === 'connecting' ? C.warning : C.danger;
  return <Animated.View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: color, opacity }} />;
}

export function T({ style, ...rest }: TextProps) {
  return <Text {...rest} style={[{ color: C.secondary, fontSize: 15, lineHeight: 22 }, style]} />;
}

/** Re-render every `ms` while active (elapsed timers). */
export function useTick(active: boolean, ms = 1000): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setN((x) => x + 1), ms);
    return () => clearInterval(t);
  }, [active, ms]);
  return n;
}

export function Divider() {
  return <View style={{ height: HAIR, backgroundColor: C.border }} />;
}
