import { EventEmitter } from 'node:events';
import type { EventEnvelope, NodeEvent, EventsPage } from '@axo/protocol';

const RING_SIZE = 5000;

/**
 * Sequenced event bus. Every event gets a monotonically increasing `seq` so a
 * reconnecting client can replay what it missed via `since(seq)`. If the gap is
 * larger than the ring (or the node restarted), `reset: true` tells the client
 * to refetch full state.
 */
export class EventBus extends EventEmitter {
  private seq = 0;
  private ring: EventEnvelope[] = [];
  private readonly nodeId: string;
  /** Random per-process epoch so clients can detect a node restart (seq reset). */
  readonly epoch = Date.now();

  constructor(nodeId: string) {
    super();
    this.nodeId = nodeId;
    this.setMaxListeners(100);
  }

  get currentSeq(): number { return this.seq; }

  publish(event: NodeEvent): EventEnvelope {
    const env = { ...event, seq: ++this.seq, ts: Date.now(), nodeId: this.nodeId } as EventEnvelope;
    // Text deltas are high-volume and only useful live; don't keep them for replay.
    if (event.type !== 'agent:text-delta') {
      this.ring.push(env);
      if (this.ring.length > RING_SIZE) this.ring.splice(0, this.ring.length - RING_SIZE);
    }
    this.emit('event', env);
    return env;
  }

  since(seq: number, epoch: number): EventsPage {
    const base = { seq: this.seq, epoch: this.epoch };
    const oldest = this.ring[0]?.seq ?? this.seq + 1;
    if (epoch !== this.epoch || seq > this.seq || seq < oldest - 1) return { events: [], reset: true, ...base };
    return { events: this.ring.filter((e) => e.seq > seq), reset: false, ...base };
  }
}
