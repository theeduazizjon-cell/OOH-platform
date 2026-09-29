import { Module } from '@nestjs/common';
import { MembershipsModule } from '../memberships/memberships.module';
import { AuthController, MeController } from './auth.controller';
import { AuthService } from './auth.service';

@Module({
  imports: [MembershipsModule],
  controllers: [AuthController, MeController],
  providers: [AuthService],
})
export class AuthModule {}
