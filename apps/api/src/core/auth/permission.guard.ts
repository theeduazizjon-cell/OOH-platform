import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { PermissionKey } from '@ooh/contracts';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../http/app-error';
import { REQUIRED_PERMISSION_KEY } from './principal';

/** Runs after AuthGuard. Enforces @RequirePermission and exposes the granted scope to handlers. */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<PermissionKey | undefined>(REQUIRED_PERMISSION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required) return true;

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const scope = request.principal?.permissions.get(required);
    if (!scope) throw new AppError('FORBIDDEN', `Missing permission: ${required}`);
    request.grantedScope = scope;
    return true;
  }
}
