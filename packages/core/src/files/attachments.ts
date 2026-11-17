import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { AttachmentsRes } from '@axo/protocol';
import { HttpError } from '../util/http-error.ts';
import { upload } from './files.ts';

/** Same conventions as the desktop composer (packages/ui/src/lib/attachments.ts). */
export const UPLOAD_DIR = '.axo/uploads';
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_ATTACHMENTS = 10;

/** Timestamped, filesystem-safe name so repeated "image.jpg" uploads don't overwrite each other. */
export function attachmentName(name: string, now = new Date()): string {
  const safe = name.replace(/\\/g, '/').split('/').pop()!.replace(/[^\w.\-]+/g, '_').replace(/^\.+/, '').slice(-80) || 'file';
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  return `${stamp}-${safe}`;
}

/** Save message attachments into the agent's folder; returns absolute paths. */
export async function saveAttachments(workdir: string, files: unknown): Promise<AttachmentsRes> {
  if (!Array.isArray(files) || !files.length) throw new HttpError(400, 'files[] required');
  if (files.length > MAX_ATTACHMENTS) throw new HttpError(400, `max ${MAX_ATTACHMENTS} attachments per message`);
  const list = (files as { name?: unknown; content?: unknown }[]).map((f) => {
    if (typeof f?.content !== 'string') throw new HttpError(400, 'each file needs base64 content');
    if (Math.floor(f.content.length * 3 / 4) > MAX_ATTACHMENT_BYTES) throw new HttpError(413, `${String(f.name ?? 'file')} is over ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB`);
    return { name: attachmentName(typeof f.name === 'string' && f.name ? f.name : 'file'), content: f.content };
  });
  const dir = join(workdir, UPLOAD_DIR);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, '.gitignore'), '*\n'); // uploads stay out of git without touching the project's .gitignore
  const res = await upload(workdir, UPLOAD_DIR, list);
  const root = workdir.replace(/\/+$/, '');
  return { paths: res.uploaded.map((u) => `${root}/${u.path}`) };
}
