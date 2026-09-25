import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../http/app-error';
import { AccessService } from './access.service';
import { IS_PUBLIC_KEY } from './principal';
import { TokenService } from './token.service';

/**
 * Global guard: every route requires a valid access token unless marked @Public().
 * The tenant comes only from the verified token, never from the URL or body.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly access: AccessService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new AppError('UNAUTHENTICATED', 'Authentication required.');

    const claims = await this.tokens.verifyAccessToken(header.slice('Bearer '.length).trim());
    const access = await this.access.resolve(claims.tenantId, claims.userId);
    if (!access || access.membershipId !== claims.membershipId) {
      throw new AppError('UNAUTHENTICATED', 'This session is no longer valid.');
    }
    // Roles/permissions changed since the token was issued: make the client refresh.
    if (access.permsVersion !== claims.permsVersion)
      throw new AppError('TOKEN_EXPIRED', 'Permissions changed.');

    request.principal = {
      userId: access.userId,
      tenantId: access.tenantId,
      membershipId: access.membershipId,
      kind: access.kind,
      permissions: access.permissions,
    };
    return true;
  }
}
