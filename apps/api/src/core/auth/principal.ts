import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import type { PermissionKey, PermissionScope } from '@ooh/contracts';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../http/app-error';

/** The authenticated caller, resolved by AuthGuard on every request. */
export interface Principal {
  readonly userId: string;
  readonly tenantId: string;
  readonly membershipId: string;
  readonly kind: 'INTERNAL' | 'EXTERNAL';
  readonly permissions: ReadonlyMap<PermissionKey, PermissionScope>;
}

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
    /** Scope at which the route's required permission is held (for scoped queries). */
    grantedScope?: PermissionScope;
  }
}

export const IS_PUBLIC_KEY = 'auth:public';
/** Route needs no access token (login, refresh, health). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export const REQUIRED_PERMISSION_KEY = 'auth:permission';
/** Route requires this catalog permission (any scope; the scope is exposed as request.grantedScope). */
export const RequirePermission = (permission: PermissionKey) =>
  SetMetadata(REQUIRED_PERMISSION_KEY, permission);

export const CurrentPrincipal = createParamDecorator((_: unknown, context: ExecutionContext): Principal => {
  const request = context.switchToHttp().getRequest<FastifyRequest>();
  if (!request.principal) throw new AppError('UNAUTHENTICATED', 'Authentication required.');
  return request.principal;
});
