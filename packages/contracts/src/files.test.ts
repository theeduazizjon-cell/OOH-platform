import { describe, expect, it } from 'vitest';
import { createUploadRequestSchema, sniffMime } from './files';

const bytes = (...parts: (number[] | string)[]) =>
  Uint8Array.from(parts.flatMap((p) => (typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p)));

describe('sniffMime', () => {
  it('recognises the allowed types by their first bytes', () => {
    expect(sniffMime(bytes([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffMime(bytes([0x89], 'PNG', [0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png');
    expect(sniffMime(bytes('RIFF', [0, 0, 0, 0], 'WEBPVP8 '))).toBe('image/webp');
    expect(sniffMime(bytes('%PDF-1.7'))).toBe('application/pdf');
    expect(sniffMime(bytes([0, 0, 0, 0x18], 'ftypheic'))).toBe('image/heic');
    expect(sniffMime(bytes([0, 0, 0, 0x18], 'ftypisom'))).toBe('video/mp4');
    expect(sniffMime(bytes([0, 0, 0, 0x14], 'ftypqt  '))).toBe('video/quicktime');
  });

  it('never trusts names: anything else is null', () => {
    expect(sniffMime(bytes('MZ', [0x90, 0]))).toBeNull(); // Windows executable
    expect(sniffMime(bytes('<svg xmlns='))).toBeNull(); // SVG can carry scripts: not allowed
    expect(sniffMime(bytes([0, 0, 0, 0x18], 'ftyp3gp4'))).toBeNull();
    expect(sniffMime(new Uint8Array())).toBeNull();
  });
});

describe('createUploadRequestSchema', () => {
  const base = {
    originalName: 'a.jpg',
    mime: 'image/jpeg',
    sizeBytes: 1000,
    sha256: 'a'.repeat(64),
    subjectType: 'asset',
    subjectId: '01a121db-f9b2-7174-a069-379731d5e881',
    purpose: 'ASSET_PHOTO',
  };

  it('defaults to internal visibility and applies per-type size limits', () => {
    expect(createUploadRequestSchema.parse(base).visibility).toBe('INTERNAL');
    expect(createUploadRequestSchema.safeParse({ ...base, sizeBytes: 26 * 1024 * 1024 }).success).toBe(false);
    expect(
      createUploadRequestSchema.safeParse({ ...base, mime: 'application/pdf', sizeBytes: 26 * 1024 * 1024 })
        .success,
    ).toBe(true);
    expect(createUploadRequestSchema.safeParse({ ...base, mime: 'image/svg+xml' }).success).toBe(false);
    expect(createUploadRequestSchema.safeParse({ ...base, sha256: 'A'.repeat(64) }).success).toBe(false);
  });
});
