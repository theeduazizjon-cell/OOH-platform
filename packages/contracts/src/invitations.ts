/**
 * Invitation contract shared by the API and the web app.
 * Flow: an admin invites an email with roles → the invitee opens `/invite/<token>` → accepts by
 * setting a password (new account) or confirming their existing password → signed in.
 */
import { z } from 'zod';
import type { MembershipListItem } from './auth';
import { PASSWORD_MAX_LENGTH } from './auth';

/** How long an invitation link stays valid. Resending issues a fresh link. */
export const INVITATION_TTL_DAYS = 7;

/** Web route that accepts an invitation token: `${origin}${INVITATION_ACCEPT_PATH}/<token>`. */
export const INVITATION_ACCEPT_PATH = '/invite';

export const inviteMemberRequestSchema = z.object({
  email: z.email().max(254),
  displayName: z.string().trim().min(1).max(120),
  roleIds: z
    .array(z.uuid())
    .min(1)
    .max(10)
    .refine((ids) => new Set(ids).size === ids.length, 'Role ids must be unique'),
});
export type InviteMemberRequest = z.infer<typeof inviteMemberRequestSchema>;

/** A freshly issued invitation. `token` is returned exactly once and is never stored in clear. */
export interface IssuedInvitation {
  id: string;
  expiresAt: string;
  token: string;
}

export interface InviteMemberResponse {
  membership: MembershipListItem;
  invitation: IssuedInvitation;
}

/** Public preview shown on the accept page before the invitee commits. */
export interface InvitationPreview {
  email: string;
  displayName: string;
  tenantName: string;
  /** true: the email already has an account, so accepting requires its current password. */
  hasAccount: boolean;
  expiresAt: string;
}

export const acceptInvitationRequestSchema = z.object({
  /** New password (new account) or the existing account's password. Policy is checked server-side. */
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  /** New accounts only: overrides the name the admin entered. */
  displayName: z.string().trim().min(1).max(120).optional(),
});
export type AcceptInvitationRequest = z.infer<typeof acceptInvitationRequestSchema>;
