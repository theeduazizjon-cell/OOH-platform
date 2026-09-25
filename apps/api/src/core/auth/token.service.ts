import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { errors, type JWTPayload, jwtVerify, SignJWT } from 'jose';
import { ENV } from '../../config/config.module';
import { type Env } from '../../config/env';
import { AppError } from '../http/app-error';

const ISSUER = 'ooh-api';
const AUDIENCE = 'ooh-web';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AccessClaims {
  readonly userId: string;
  readonly tenantId: string;
  readonly membershipId: string;
  readonly permsVersion: number;
}

export interface RefreshCookie {
  readonly userId: string;
  readonly tokenId: string;
  readonly secret: string;
}

/**
 * Access tokens: short-lived HS256 JWTs (single verifier today; ADR-0006).
 * Refresh tokens: opaque `<userId>.<tokenId>.<secret>`; only SHA-256(secret) is stored. The
 * secret has 256 bits of entropy, so a fast hash is appropriate (unlike passwords).
 */
@Injectable()
export class TokenService {
  private readonly key: Uint8Array;

  constructor(@Inject(ENV) private readonly env: Env) {
    this.key = new TextEncoder().encode(env.JWT_SECRET);
  }

  async signAccessToken(claims: AccessClaims): Promise<{ token: string; expiresAt: Date }> {
    const expiresAt = new Date(Date.now() + this.env.ACCESS_TOKEN_TTL_SECONDS * 1000);
    const token = await new SignJWT({
      tid: claims.tenantId,
      mid: claims.membershipId,
      pv: claims.permsVersion,
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(claims.userId)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
      .sign(this.key);
    return { token, expiresAt };
  }

  async verifyAccessToken(token: string): Promise<AccessClaims> {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.key, {
        issuer: ISSUER,
        audience: AUDIENCE,
        algorithms: ['HS256'],
      }));
    } catch (error) {
      if (error instanceof errors.JWTExpired) throw new AppError('TOKEN_EXPIRED', 'Access token expired.');
      throw new AppError('UNAUTHENTICATED', 'Invalid access token.');
    }
    const { sub, tid, mid, pv } = payload;
    if (
      typeof sub !== 'string' ||
      !UUID_RE.test(sub) ||
      typeof tid !== 'string' ||
      !UUID_RE.test(tid) ||
      typeof mid !== 'string' ||
      !UUID_RE.test(mid) ||
      typeof pv !== 'number'
    ) {
      throw new AppError('UNAUTHENTICATED', 'Invalid access token.');
    }
    return { userId: sub, tenantId: tid, membershipId: mid, permsVersion: pv };
  }

  newRefreshSecret(): { secret: string; hash: string } {
    const secret = randomBytes(32).toString('base64url');
    return { secret, hash: this.hashRefreshSecret(secret) };
  }

  hashRefreshSecret(secret: string): string {
    return createHash('sha256').update(secret).digest('base64url');
  }

  refreshSecretMatches(secret: string, storedHash: string): boolean {
    const actual = Buffer.from(this.hashRefreshSecret(secret));
    const expected = Buffer.from(storedHash);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  refreshTokenExpiry(): Date {
    return new Date(Date.now() + this.env.REFRESH_TOKEN_TTL_DAYS * 24 * 3600 * 1000);
  }

  static formatRefreshCookie(cookie: RefreshCookie): string {
    return `${cookie.userId}.${cookie.tokenId}.${cookie.secret}`;
  }

  static parseRefreshCookie(value: string | undefined): RefreshCookie | null {
    if (!value || value.length > 200) return null;
    const [userId, tokenId, secret, ...rest] = value.split('.');
    if (rest.length > 0 || !userId || !tokenId || !secret) return null;
    if (!UUID_RE.test(userId) || !UUID_RE.test(tokenId) || !/^[A-Za-z0-9_-]{43}$/.test(secret)) return null;
    return { userId, tokenId, secret };
  }
}
