import { z } from 'zod';

/**
 * Files (docs/architecture/08-system-architecture.md §4): upload straight to storage with a short-lived
 * URL, then processing checks size, checksum, real type and viruses before anything is served.
 */

export const FILE_PURPOSES = ['ASSET_PHOTO', 'ATTACHMENT', 'ARTWORK', 'SIMULATION', 'STUDY_EXPORT'] as const;
export type FilePurpose = (typeof FILE_PURPOSES)[number];
export const FILE_VISIBILITIES = ['INTERNAL', 'EXTERNAL'] as const;
export const FILE_STATUSES = ['PENDING', 'READY', 'QUARANTINED', 'REJECTED'] as const;
export type FileStatus = (typeof FILE_STATUSES)[number];
/** Records files can be attached to (more join with their modules). */
export const FILE_SUBJECT_TYPES = ['asset'] as const;
export type FileSubjectType = (typeof FILE_SUBJECT_TYPES)[number];

const MB = 1024 * 1024;
/** The allow-list: declared type → size limit (08 §4: images 25 MB, documents 50 MB, video 300 MB). */
export const FILE_TYPE_LIMITS = {
  'image/jpeg': 25 * MB,
  'image/png': 25 * MB,
  'image/webp': 25 * MB,
  'image/heic': 25 * MB,
  'application/pdf': 50 * MB,
  'video/mp4': 300 * MB,
  'video/quicktime': 300 * MB,
} as const;
export type AllowedMime = keyof typeof FILE_TYPE_LIMITS;
export const ALLOWED_MIMES = Object.keys(FILE_TYPE_LIMITS) as AllowedMime[];

/** How long an upload or download URL stays valid. */
export const UPLOAD_URL_SECONDS = 10 * 60;
export const DOWNLOAD_URL_SECONDS = 5 * 60;

/**
 * The real type from the first bytes (never trusting the name or the declared type); null when the
 * bytes match nothing on the allow-list.
 */
export function sniffMime(head: Uint8Array): AllowedMime | null {
  const starts = (...bytes: number[]) => bytes.every((b, i) => head[i] === b);
  const ascii = (from: number, text: string) => [...text].every((c, i) => head[from + i] === c.charCodeAt(0));
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp';
  if (ascii(0, '%PDF-')) return 'application/pdf';
  if (ascii(4, 'ftyp')) {
    const brand = String.fromCharCode(...head.slice(8, 12));
    if (['heic', 'heix', 'mif1', 'msf1', 'heim', 'heis'].includes(brand)) return 'image/heic';
    if (brand === 'qt  ') return 'video/quicktime';
    if (['isom', 'iso2', 'mp41', 'mp42', 'avc1', 'M4V ', 'dash'].includes(brand)) return 'video/mp4';
  }
  return null;
}

export interface FileItem {
  id: string;
  originalName: string;
  mime: string;
  sizeBytes: number;
  status: FileStatus;
  statusReason: string | null;
  width: number | null;
  height: number | null;
  hasThumbnail: boolean;
  uploadedAt: string | null;
  processedAt: string | null;
  createdAt: string;
}

export interface FileLinkItem {
  linkId: string;
  subjectType: FileSubjectType;
  subjectId: string;
  purpose: FilePurpose;
  visibility: (typeof FILE_VISIBILITIES)[number];
  file: FileItem;
}

/** POST /files/uploads response: send the bytes with `method` to `url`, with exactly `headers`. */
export interface UploadTicket {
  link: FileLinkItem;
  upload: { url: string; method: 'PUT'; headers: Record<string, string>; expiresAt: string };
}

export const createUploadRequestSchema = z
  .object({
    originalName: z.string().trim().min(1).max(255),
    mime: z.enum(ALLOWED_MIMES as [AllowedMime, ...AllowedMime[]]),
    sizeBytes: z.number().int().min(1),
    sha256: z.string().regex(/^[0-9a-f]{64}$/, 'SHA-256 as 64 lowercase hex characters'),
    /** Every file belongs to a record; access to the file follows access to the record. */
    subjectType: z.enum(FILE_SUBJECT_TYPES),
    subjectId: z.uuid(),
    purpose: z.enum(FILE_PURPOSES),
    visibility: z.enum(FILE_VISIBILITIES).default('INTERNAL'),
  })
  .refine((b) => b.sizeBytes <= FILE_TYPE_LIMITS[b.mime], {
    message: 'The file is larger than allowed for its type',
    path: ['sizeBytes'],
  });
export type CreateUploadRequest = z.infer<typeof createUploadRequestSchema>;

export const fileListQuerySchema = z.object({
  subjectType: z.enum(FILE_SUBJECT_TYPES),
  subjectId: z.uuid(),
  purpose: z.enum(FILE_PURPOSES).optional(),
});

export const fileUrlQuerySchema = z.object({ variant: z.enum(['original', 'thumb']).default('original') });
