import type { Agent, UploadRes } from '@axo/protocol';
import type { NodeClient } from './client.ts';

/**
 * Composer attachments. Messages are text, so a file is uploaded into the agent's folder under
 * .axo/uploads/ and its absolute path goes into the message; Claude reads images and files by path.
 */
export const UPLOAD_DIR = '.axo/uploads';
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/** Timestamped, filesystem-safe name so repeated "image.png" pastes don't overwrite each other. */
export function attachmentName(name: string, now = new Date()): string {
  const safe = name.replace(/[^\w.\-]+/g, '_').replace(/^\.+/, '').slice(-80) || 'file';
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  return `${stamp}-${safe}`;
}

/** The text sent for a message with attachments. */
export function withAttachments(text: string, paths: string[]): string {
  if (!paths.length) return text;
  const list = paths.map((p) => `- ${p}`).join('\n');
  return `${text ? `${text}\n\n` : ''}Attached file${paths.length > 1 ? 's' : ''}:\n${list}`;
}

const readBase64 = (f: File) => new Promise<string>((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
  r.onerror = () => reject(r.error);
  r.readAsDataURL(f);
});

/** Upload files into the agent's folder; returns their absolute paths. */
export async function uploadAttachments(client: NodeClient, agent: Agent, files: File[]): Promise<string[]> {
  const big = files.find((f) => f.size > MAX_ATTACHMENT_BYTES);
  if (big) throw new Error(`${big.name} is over ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`);
  const list = await Promise.all(files.map(async (f) => ({ name: attachmentName(f.name || 'pasted.png'), content: await readBase64(f) })));
  // Keep uploads out of git without touching the project's own .gitignore.
  list.push({ name: '.gitignore', content: btoa('*\n') });
  const res = await client.post<UploadRes>(`/projects/${agent.projectId}/files/upload?agent=${encodeURIComponent(agent.id)}`, { dir: UPLOAD_DIR, files: list });
  const root = agent.workdir.replace(/\/+$/, '');
  return res.uploaded.filter((u) => !u.path.endsWith('/.gitignore')).map((u) => `${root}/${u.path}`);
}
