/**
 * Object storage behind an interface (08-system-architecture.md §4): browsers upload and download
 * directly with short-lived URLs; the API never streams user files except through LocalFileStorage
 * (development), which emulates presigned URLs with HMAC-signed tokens.
 */
export interface PresignedUpload {
  url: string;
  /** Headers the client must send exactly (they are part of the signature). */
  headers: Record<string, string>;
}

export interface FileStorage {
  presignPut(input: {
    key: string;
    contentType: string;
    sizeBytes: number;
    expiresIn: number;
  }): Promise<PresignedUpload>;
  presignGet(input: {
    key: string;
    fileName: string;
    contentType: string;
    expiresIn: number;
  }): Promise<string>;
  /** Size of a stored object, or null when it doesn't exist (yet). */
  head(key: string): Promise<{ sizeBytes: number } | null>;
  read(key: string): Promise<Buffer>;
  write(key: string, body: Buffer, contentType: string): Promise<void>;
}

export const FILE_STORAGE = Symbol('FILE_STORAGE');

/** `attachment; filename="…"` with a safe ASCII fallback and the UTF-8 name (RFC 6266). */
export function contentDisposition(
  fileName: string,
  disposition: 'attachment' | 'inline' = 'attachment',
): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}
