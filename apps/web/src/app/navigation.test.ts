import type { MeResponse } from '@ooh/contracts';
import { describe, expect, it } from 'vitest';
import { visibleNavItems } from './navigation';

const me = (permissions: MeResponse['permissions']) => ({ permissions }) as MeResponse;

describe('visibleNavItems', () => {
  it('shows only modules the user holds the permission for', () => {
    const labels = visibleNavItems(me({ 'dashboard.read': 'ALL', 'campaign.read': 'ALL' })).map(
      (i) => i.label,
    );
    expect(labels).toEqual(['Dashboard', 'Campaigns']);
  });

  it('hides Admin from users without users.read', () => {
    expect(visibleNavItems(me({ 'dashboard.read': 'ALL' })).map((i) => i.label)).not.toContain('Admin');
    expect(visibleNavItems(me({ 'users.read': 'ALL' })).map((i) => i.label)).toContain('Admin');
  });
});
