import type { MembershipListItem } from '@ooh/contracts';
import { describe, expect, it } from 'vitest';
import { invitationUrl } from './invitation-link';
import { memberStatusLabel } from './users-page';

const NOW = Date.parse('2026-10-01T12:00:00Z');
const member = (status: MembershipListItem['status'], expiresAt?: string): MembershipListItem => ({
  id: 'm',
  userId: 'u',
  displayName: 'Ana',
  email: 'ana@example.com',
  kind: 'INTERNAL',
  status,
  roles: [],
  invitation: expiresAt ? { expiresAt } : null,
  version: 1,
});

describe('memberStatusLabel', () => {
  it('describes active, suspended, pending and lapsed invitations', () => {
    expect(memberStatusLabel(member('ACTIVE'), NOW)).toBe('Active');
    expect(memberStatusLabel(member('SUSPENDED'), NOW)).toBe('Suspended');
    expect(memberStatusLabel(member('INVITED', '2026-10-05T12:00:00Z'), NOW)).toMatch(/^Invited · expires /);
    expect(memberStatusLabel(member('INVITED', '2026-09-30T12:00:00Z'), NOW)).toBe('Invitation expired');
    expect(memberStatusLabel(member('INVITED'), NOW)).toBe('Invitation expired');
  });
});

describe('invitationUrl', () => {
  it('builds the public accept link on this origin', () => {
    expect(invitationUrl('0192abcd.secret_-x', 'https://app.example')).toBe(
      'https://app.example/invite/0192abcd.secret_-x',
    );
  });
});
