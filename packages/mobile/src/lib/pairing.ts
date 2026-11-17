// Pairing: the desktop shows one QR code with a device token per node (docs/MOBILE.md).
import type { PairingPayload } from '@axo/protocol';

export type PairedNode = PairingPayload['nodes'][number];

/**
 * Cleartext HTTP is allowed app-wide (Android's network security config can't express a CIDR),
 * so the app itself only talks to Tailscale addresses: 100.64.0.0/10 or MagicDNS (*.ts.net).
 * Dev builds also accept localhost and the emulator's host alias.
 */
export function isAllowedUrl(raw: string): boolean {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol === 'https:') return true;
  if (u.protocol !== 'http:') return false;
  const host = u.hostname;
  if (host.endsWith('.ts.net')) return true;
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (m && Number(m[1]) === 100 && Number(m[2]) >= 64 && Number(m[2]) <= 127) return true;
  if (__DEV__ && ['localhost', '127.0.0.1', '10.0.2.2'].includes(host)) return true;
  return false;
}

/** Parse the QR text. Throws with a message a person can act on. */
export function parsePairing(text: string): PairedNode[] {
  let data: any;
  try { data = JSON.parse(text.trim()); } catch { throw new Error("That isn't an Axo pairing code."); }
  if (data?.v !== 1 || !Array.isArray(data.nodes)) throw new Error("That isn't an Axo pairing code.");
  const nodes: PairedNode[] = [];
  for (const n of data.nodes) {
    if (typeof n?.id !== 'string' || typeof n.url !== 'string' || typeof n.token !== 'string') continue;
    const url = n.url.replace(/\/+$/, '');
    if (!isAllowedUrl(url)) throw new Error(`${n.name ?? n.id}: ${url} is not a Tailscale address.`);
    nodes.push({ id: n.id, name: typeof n.name === 'string' && n.name ? n.name : n.id, url, token: n.token });
  }
  if (!nodes.length) throw new Error('The pairing code has no servers in it. Turn on the Tailscale listener on a server and pair again.');
  return nodes;
}
