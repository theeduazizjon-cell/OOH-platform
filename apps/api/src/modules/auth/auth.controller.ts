import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import {
  type AuthSession,
  CSRF_HEADER,
  loginRequestSchema,
  type MeResponse,
  REFRESH_COOKIE_NAME,
  REFRESH_COOKIE_PATH,
  switchTenantRequestSchema,
} from '@ooh/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ENV } from '../../config/config.module';
import { type Env } from '../../config/env';
import { CurrentPrincipal, type Principal, Public } from '../../core/auth/principal';
import { TokenService } from '../../core/auth/token.service';
import { AppError } from '../../core/http/app-error';
import { clientInfo } from '../../core/http/client-info';
import { parseWith } from '../../core/http/validation';
import { AuthService, type IssuedSession } from './auth.service';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AuthSession> {
    const issued = await this.auth.login(parseWith(loginRequestSchema, body), clientInfo(request));
    return this.respond(reply, issued);
  }

  /** Cookie-authenticated: exchanges the refresh cookie for a new access token (and rotated cookie). */
  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AuthSession> {
    this.assertCsrfHeader(request);
    try {
      return this.respond(reply, await this.auth.refresh(this.readCookie(request), clientInfo(request)));
    } catch (error) {
      this.clearCookie(reply);
      throw error;
    }
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    this.assertCsrfHeader(request);
    await this.auth.logout(this.readCookie(request), clientInfo(request));
    this.clearCookie(reply);
  }

  @Post('switch-tenant')
  @HttpCode(200)
  async switchTenant(
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AuthSession> {
    this.assertCsrfHeader(request);
    const { tenantId } = parseWith(switchTenantRequestSchema, body);
    return this.respond(
      reply,
      await this.auth.switchTenant(principal, tenantId, this.readCookie(request), clientInfo(request)),
    );
  }

  private respond(reply: FastifyReply, issued: IssuedSession): AuthSession {
    void reply.setCookie(REFRESH_COOKIE_NAME, issued.refresh.value, {
      httpOnly: true,
      secure: this.env.COOKIE_SECURE,
      sameSite: 'strict',
      path: REFRESH_COOKIE_PATH,
      expires: issued.refresh.expiresAt,
    });
    void reply.header('cache-control', 'no-store');
    return issued.session;
  }

  private clearCookie(reply: FastifyReply): void {
    void reply.clearCookie(REFRESH_COOKIE_NAME, { path: REFRESH_COOKIE_PATH });
  }

  private readCookie(request: FastifyRequest) {
    return TokenService.parseRefreshCookie(request.cookies[REFRESH_COOKIE_NAME]);
  }

  private assertCsrfHeader(request: FastifyRequest): void {
    if (request.headers[CSRF_HEADER] !== '1')
      throw new AppError('FORBIDDEN', `Missing ${CSRF_HEADER} header.`);
  }
}

@Controller('me')
export class MeController {
  constructor(private readonly auth: AuthService) {}

  @Get()
  me(@CurrentPrincipal() principal: Principal): Promise<MeResponse> {
    return this.auth.me(principal);
  }
}
