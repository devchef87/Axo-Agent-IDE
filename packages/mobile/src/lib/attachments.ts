// Composer attachments, mirroring packages/ui/src/lib/attachments.ts. Messages are text, so files are
// uploaded into the agent's folder (.axo/uploads/) and their absolute paths go into the message;
// Claude reads images and files by path.

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export interface Attachment {
  id: string;
  uri: string;              // local file:// or content:// uri
  name: string;
  mimeType: string | null;
  size: number | null;
  image: boolean;           // show a thumbnail
}

/** The text sent for a message with attachments (same wording as the desktop). */
export function withAttachments(text: string, paths: string[]): string {
  if (!paths.length) return text;
  const list = paths.map((p) => `- ${p}`).join('\n');
  return `${text ? `${text}\n\n` : ''}Attached file${paths.length > 1 ? 's' : ''}:\n${list}`;
}

/** A name for a picked asset that has none (camera shots, some gallery items). */
export function nameFor(uri: string, mimeType: string | null | undefined, fallback = 'file'): string {
  const last = decodeURIComponent(uri.split(/[/?#]/).filter(Boolean).at(-1) ?? '');
  if (/\.[a-z0-9]{2,5}$/i.test(last)) return last;
  const ext = mimeType?.split('/')[1]?.replace('jpeg', 'jpg').replace(/[^a-z0-9]/gi, '');
  return ext ? `${fallback}.${ext}` : fallback;
}

export function formatBytes(n: number | null): string {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
