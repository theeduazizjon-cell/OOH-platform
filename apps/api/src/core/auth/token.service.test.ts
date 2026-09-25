import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { type Env, loadEnv } from '../../config/env';
import { AppError } from '../http/app-error';
import { TokenService } from './token.service';

const env: Env = loadEnv({
  DATABASE_URL: 'postgres://a:b@localhost/x',
  REDIS_URL: 'redis://localhost',
  JWT_SECRET: 'unit-test-secret-unit-test-secret-1234',
});
const service = new TokenService(env);
const claims = {
  userId: '01000000-0000-7000-8000-000000000001',
  tenantId: '01000000-0000-7000-8000-000000000002',
  membershipId: '01000000-0000-7000-8000-000000000003',
  permsVersion: 3,
};

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return error instanceof AppError ? error.code : 'OTHER';
  }
  return undefined;
}

describe('access tokens', () => {
  it('round-trips claims', async () => {
    const { token, expiresAt } = await service.signAccessToken(claims);
    expect(await service.verifyAccessToken(token)).toEqual(claims);
    expect(expiresAt.getTime() - Date.now()).toBeGreaterThan(590_000);
  });

  it('rejects tampered tokens, other keys and other audiences', async () => {
    const { token } = await service.signAccessToken(claims);
    const [header, , signature] = token.split('.');
    const forgedPayload = Buffer.from(JSON.stringify({ sub: claims.userId, tid: 'x' })).toString('base64url');
    expect(await codeOf(service.verifyAccessToken(`${header}.${forgedPayload}.${signature}`))).toBe(
      'UNAUTHENTICATED',
    );

    const other = new TokenService({ ...env, JWT_SECRET: 'another-secret-another-secret-12345' });
    expect(await codeOf(other.verifyAccessToken(token))).toBe('UNAUTHENTICATED');

    const wrongAudience = await new SignJWT({ tid: claims.tenantId, mid: claims.membershipId, pv: 1 })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(claims.userId)
      .setIssuer('ooh-api')
      .setAudience('someone-else')
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode(env.JWT_SECRET));
    expect(await codeOf(service.verifyAccessToken(wrongAudience))).toBe('UNAUTHENTICATED');
  });

  it('reports expiry distinctly so clients know to refresh', async () => {
    const expired = await new SignJWT({ tid: claims.tenantId, mid: claims.membershipId, pv: 1 })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(claims.userId)
      .setIssuer('ooh-api')
      .setAudience('ooh-web')
      .setExpirationTime(Math.floor(Date.now() / 1000) - 10)
      .sign(new TextEncoder().encode(env.JWT_SECRET));
    expect(await codeOf(service.verifyAccessToken(expired))).toBe('TOKEN_EXPIRED');
  });

  it('rejects the "none" algorithm', async () => {
    const unsigned = [
      Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
      Buffer.from(
        JSON.stringify({ sub: claims.userId, tid: claims.tenantId, mid: claims.membershipId, pv: 1 }),
      ).toString('base64url'),
      '',
    ].join('.');
    expect(await codeOf(service.verifyAccessToken(unsigned))).toBe('UNAUTHENTICATED');
  });
});

describe('refresh tokens', () => {
  it('stores only a hash and matches the secret in constant time', () => {
    const { secret, hash } = service.newRefreshSecret();
    expect(hash).not.toContain(secret);
    expect(service.refreshSecretMatches(secret, hash)).toBe(true);
    expect(service.refreshSecretMatches(service.newRefreshSecret().secret, hash)).toBe(false);
  });

  it('formats and strictly parses the cookie', () => {
    const { secret } = service.newRefreshSecret();
    const value = TokenService.formatRefreshCookie({
      userId: claims.userId,
      tokenId: claims.tenantId,
      secret,
    });
    expect(TokenService.parseRefreshCookie(value)).toEqual({
      userId: claims.userId,
      tokenId: claims.tenantId,
      secret,
    });
    for (const bad of [
      undefined,
      '',
      'a.b.c',
      `${claims.userId}.${claims.tenantId}`,
      `${value}.extra`,
      'x'.repeat(300),
    ]) {
      expect(TokenService.parseRefreshCookie(bad)).toBeNull();
    }
  });
});
