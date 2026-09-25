import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AccessService } from './access.service';
import { AuthGuard } from './auth.guard';
import { LoginThrottle, RedisThrottleStore, THROTTLE_STORE } from './login-throttle';
import { PasswordService } from './password.service';
import { PermissionGuard } from './permission.guard';
import { TokenService } from './token.service';

/** Authentication primitives + the global guards (order matters: authenticate, then authorize). */
@Global()
@Module({
  providers: [
    AccessService,
    PasswordService,
    TokenService,
    LoginThrottle,
    { provide: THROTTLE_STORE, useClass: RedisThrottleStore },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: PermissionGuard },
  ],
  exports: [AccessService, PasswordService, TokenService, LoginThrottle],
})
export class AuthCoreModule {}
