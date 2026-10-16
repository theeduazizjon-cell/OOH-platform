import {
  ALLOWED_MIMES,
  type AllowedMime,
  type FileItem,
  type FilePurpose,
  type FileSubjectType,
  FILE_TYPE_LIMITS,
  type UploadTicket,
} from '@ooh/contracts';
import { api } from './api';

export class UploadError extends Error {}

const ACCEPTED_LABEL = 'JPEG, PNG, WebP, HEIC, PDF, MP4 or MOV';

/** Client-side check against the API's allow-list, for an early, friendly message. */
export function uploadProblem(file: Pick<File, 'type' | 'size'>, allowed = ALLOWED_MIMES): string | null {
  if (!(allowed as readonly string[]).includes(file.type)) return `Upload ${ACCEPTED_LABEL} files only.`;
  const limit = FILE_TYPE_LIMITS[file.type as AllowedMime];
  if (file.size > limit) return `The file is larger than ${Math.round(limit / 1024 / 1024)} MB.`;
  if (file.size === 0) return 'The file is empty.';
  return null;
}

export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Uploads one file for a record (08-system-architecture.md §4): ticket from the API, the bytes
 * straight to storage with the signed URL, then "complete" queues processing (the file stays
 * PENDING until size, checksum, real type and the virus scan are checked).
 */
export async function uploadFile(
  file: File,
  target: { subjectType: FileSubjectType; subjectId: string; purpose: FilePurpose },
): Promise<FileItem> {
  const problem = uploadProblem(file);
  if (problem) throw new UploadError(problem);
  const bytes = await file.arrayBuffer();
  const ticket = await api.request<UploadTicket>('/files/uploads', {
    method: 'POST',
    json: {
      originalName: file.name,
      mime: file.type,
      sizeBytes: file.size,
      sha256: await sha256Hex(bytes),
      ...target,
    },
  });
  const sent = await fetch(ticket.upload.url, {
    method: ticket.upload.method,
    headers: ticket.upload.headers,
    body: bytes,
  });
  if (!sent.ok) throw new UploadError(`${file.name}: the upload failed (${sent.status}). Try again.`);
  return api.request<FileItem>(`/files/${ticket.link.file.id}/complete`, { method: 'POST' });
}
