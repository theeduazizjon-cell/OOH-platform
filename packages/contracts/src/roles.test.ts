import { describe, expect, it } from 'vitest';
import { AI_FORBIDDEN_PERMISSIONS, PERMISSIONS, validateGrants, type PermissionKey } from './permissions';
import { ROLE_TEMPLATES } from './roles';

describe('permission catalog', () => {
  it('uses resource.action key format', () => {
    for (const key of Object.keys(PERMISSIONS)) {
      expect(key).toMatch(/^[a-z_]+(\.[a-z_]+)+$/);
    }
  });

  it('forbids the AI from every human-decision permission listed in R§39', () => {
    const required: PermissionKey[] = [
      'study.decide', // approve an OOH location / final client approval
      'study.publish',
      'asset.availability.manage', // declare a pole available
      'asset.terms.manage', // assume ownership rights
      'commercial.write', // change financial data
      'commercial.lock', // approve invoices / billable items
      'evidence.review', // declare installation completed
      'field_job.execute',
    ];
    for (const key of required) expect(AI_FORBIDDEN_PERMISSIONS).toContain(key);
  });
});

describe('role templates', () => {
  it('have unique keys', () => {
    const keys = ROLE_TEMPLATES.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it.each(ROLE_TEMPLATES.map((r) => [r.key, r] as const))('%s has only valid grants', (_key, role) => {
    expect(validateGrants(role.grants, { external: role.external })).toEqual([]);
    expect(role.grants.length).toBeGreaterThan(0);
  });

  it('never give external roles tenant-wide (ALL) scope', () => {
    for (const role of ROLE_TEMPLATES.filter((r) => r.external)) {
      expect(role.grants.filter((g) => g.scope === 'ALL')).toEqual([]);
    }
  });

  it('keep client decisions with the external party; internal staff use decide_on_behalf', () => {
    const admin = ROLE_TEMPLATES.find((r) => r.key === 'company_admin')!;
    const perms = admin.grants.map((g) => g.permission);
    expect(perms).not.toContain('study.decide');
    expect(perms).toContain('study.decide_on_behalf');
  });
});

describe('validateGrants', () => {
  it('reports unknown, duplicate, out-of-scope and internal-only grants', () => {
    const violations = validateGrants(
      [
        { permission: 'nope.read', scope: 'ALL' },
        { permission: 'campaign.read', scope: 'ORGANISATION' },
        { permission: 'campaign.read', scope: 'ORGANISATION' },
        { permission: 'study.decide', scope: 'ALL' },
        { permission: 'commercial.margin.read', scope: 'ALL' },
      ],
      { external: true },
    );
    expect(violations).toEqual([
      { permission: 'nope.read', reason: 'UNKNOWN_PERMISSION' },
      { permission: 'campaign.read', reason: 'DUPLICATE' },
      { permission: 'study.decide', reason: 'SCOPE_NOT_ALLOWED' },
      { permission: 'commercial.margin.read', reason: 'INTERNAL_ONLY' },
    ]);
  });
});
