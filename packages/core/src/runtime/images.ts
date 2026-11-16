// Images from tool results (Read of a PNG, screenshots, …). Stored as files under
// <home>/agents/<agentId>/images, never in the feed table. Bounded: each image ≤ 5 MB,
// at most MAX_PER_AGENT per agent (oldest dropped), and the folder goes with the agent.
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ResultImage } from './parser.ts';

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_PER_AGENT = 100;
const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
export const IMAGE_MIME: Record<string, string> = Object.fromEntries(Object.entries(EXT).map(([m, e]) => [e, m]));
const ID = /^[a-f0-9]{24}\.(png|jpg|gif|webp)$/;

export class ImageStore {
  private readonly home: string;
  constructor(home: string) { this.home = home; }

  private dir(agentId: string): string { return join(this.home, 'agents', agentId, 'images'); }

  /** Save images; returns their ids (content-addressed, so repeats are stored once). */
  save(agentId: string, images: ResultImage[]): { id: string; mediaType: string }[] {
    const dir = this.dir(agentId);
    const out: { id: string; mediaType: string }[] = [];
    for (const img of images) {
      const buf = Buffer.from(img.data, 'base64');
      if (!buf.length || buf.length > MAX_BYTES || !EXT[img.mediaType]) continue;
      const id = `${createHash('sha256').update(buf).digest('hex').slice(0, 24)}.${EXT[img.mediaType]}`;
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, id), buf);
      out.push({ id, mediaType: img.mediaType });
    }
    if (out.length) this.prune(dir);
    return out;
  }

  /** Absolute path for a stored image, or null for anything that isn't a valid id. */
  path(agentId: string, id: string): string | null {
    if (!ID.test(id) || !/^[\w-]+$/.test(agentId)) return null;
    return join(this.dir(agentId), id);
  }

  remove(agentId: string): void {
    if (/^[\w-]+$/.test(agentId)) rmSync(this.dir(agentId), { recursive: true, force: true });
  }

  private prune(dir: string): void {
    let files: { f: string; t: number }[];
    try { files = readdirSync(dir).map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs })); } catch { return; }
    if (files.length <= MAX_PER_AGENT) return;
    files.sort((a, b) => a.t - b.t);
    for (const { f } of files.slice(0, files.length - MAX_PER_AGENT)) rmSync(join(dir, f), { force: true });
  }
}
