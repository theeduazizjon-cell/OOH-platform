import { Module } from '@nestjs/common';
import { InvitationsService } from './invitations.service';
import { MembershipsController } from './memberships.controller';
import { MembershipsService } from './memberships.service';

@Module({
  controllers: [MembershipsController],
  providers: [MembershipsService, InvitationsService],
  // The public accept endpoints live with the other /auth routes, because accepting signs you in.
  exports: [InvitationsService],
})
export class MembershipsModule {}
