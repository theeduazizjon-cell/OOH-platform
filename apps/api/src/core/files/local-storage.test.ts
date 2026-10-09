import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LocalFileStorage } from './local-storage';

const tokenOf = (url: string) => new URL(url, 'http://x').searchParams.get('token')!;

describe('LocalFileStorage', () => {
  let now = 1_800_000_000_000;
  const storage = new LocalFileStorage(mkdtempSync(join(tmpdir(), 'ooh-ls-')), 'secret', () => now);

  it('signs grants that verify only for their method, and not after expiry', async () => {
    const put = await storage.presignPut({
      key: 't/1',
      contentType: 'image/png',
      sizeBytes: 5,
      expiresIn: 60,
    });
    expect(put.headers).toEqual({ 'content-type': 'image/png' });
    const token = tokenOf(put.url);
    expect(storage.verify(token, 'PUT')).toMatchObject({ k: 't/1', t: 'image/png', s: 5 });
    expect(storage.verify(token, 'GET')).toBeNull();
    now += 61_000;
    expect(storage.verify(token, 'PUT')).toBeNull();
  });

  it('rejects tampered tokens and tokens signed with another secret', async () => {
    const token = tokenOf(
      await storage.presignGet({ key: 't/1', fileName: 'a.png', contentType: 'image/png', expiresIn: 60 }),
    );
    const [payload, signature] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({ k: 't/2', m: 'GET', e: 9_999_999_999, t: 'image/png' }),
    ).toString('base64url');
    expect(storage.verify(`${forged}.${signature}`, 'GET')).toBeNull();
    expect(storage.verify(`${payload}.`, 'GET')).toBeNull();
    const other = new LocalFileStorage(tmpdir(), 'other-secret', () => now);
    expect(other.verify(token, 'GET')).toBeNull();
  });

  it('stores and reads objects but never outside its directory', async () => {
    await storage.write('t/2026/a', Buffer.from('hello'));
    expect(await storage.head('t/2026/a')).toEqual({ sizeBytes: 5 });
    expect((await storage.read('t/2026/a')).toString()).toBe('hello');
    expect(await storage.head('t/missing')).toBeNull();
    await expect(storage.write('../escape', Buffer.from('x'))).rejects.toThrow('Invalid storage key');
  });
});
