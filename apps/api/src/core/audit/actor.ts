import { type Principal } from '../auth/principal';
import { type ClientInfo } from '../http/client-info';

/** Who did something, as the audit trail records it: a signed-in user, or the platform itself. */
export interface Actor {
  readonly tenantId: string;
  readonly actorType: 'USER' | 'SYSTEM';
  readonly actorUserId: string | null;
  readonly actorMembershipId: string | null;
  readonly client?: ClientInfo;
}

export function userActor(principal: Principal, client: ClientInfo): Actor {
  return {
    tenantId: principal.tenantId,
    actorType: 'USER',
    actorUserId: principal.userId,
    actorMembershipId: principal.membershipId,
    client,
  };
}

/** The worker acting on an event (no user, no request). */
export function systemActor(tenantId: string): Actor {
  return { tenantId, actorType: 'SYSTEM', actorUserId: null, actorMembershipId: null };
}
