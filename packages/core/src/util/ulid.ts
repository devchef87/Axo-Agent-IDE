import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
let lastTime = 0;
let lastRand: number[] = [];

/** Monotonic ULID (lowercased). Sortable by creation time. */
export function ulid(now = Date.now()): string {
  let rand: number[];
  if (now === lastTime) {
    rand = lastRand.slice();
    for (let i = rand.length - 1; i >= 0; i--) {
      if (rand[i] < 31) { rand[i]++; break; }
      rand[i] = 0;
    }
  } else {
    const bytes = randomBytes(16);
    rand = Array.from({ length: 16 }, (_, i) => bytes[i] % 32);
  }
  lastTime = now;
  lastRand = rand;
  let time = '';
  let t = now;
  for (let i = 0; i < 10; i++) { time = ALPHABET[t % 32] + time; t = Math.floor(t / 32); }
  return (time + rand.map((n) => ALPHABET[n]).join('')).toLowerCase();
}
