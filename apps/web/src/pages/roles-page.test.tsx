import type { Page, RoleListItem } from '@ooh/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { api, ApiError } from '@/lib/api';
import type * as MeModule from '@/lib/me';
import { ROLE_CONFLICT_MESSAGE, RolesPage } from './roles-page';

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ session: { tenantId: 't1', membershipId: 'me' } }),
}));
// Only roles.* here: the Users|Roles tabs (router links) render only with both areas visible.
vi.mock('@/lib/me', async (importOriginal) => ({
  ...(await importOriginal<typeof MeModule>()),
  useMe: () => ({
    data: { membership: { id: 'me' }, permissions: { 'roles.read': 'ALL', 'roles.manage': 'ALL' } },
  }),
}));

const role = (over: Partial<RoleListItem>): RoleListItem => ({
  id: 'r1',
  key: 'custom_ops',
  name: 'Ops',
  description: null,
  isSystem: false,
  isExternal: false,
  active: true,
  memberCount: 0,
  version: 5,
  ...over,
});

type RequestArgs = Parameters<typeof api.request>;
let requestSpy: MockInstance<(...args: RequestArgs) => Promise<unknown>>;
const listCalls = () => requestSpy.mock.calls.filter(([path, init]) => path === '/roles' && !init);
const patchCalls = () => requestSpy.mock.calls.filter(([, init]) => init?.method === 'PATCH');

function renderPage(roles: RoleListItem[], onPatch: () => Promise<unknown>) {
  requestSpy = vi.spyOn(api, 'request').mockImplementation((path, init) => {
    if (path === '/roles' && !init) {
      return Promise.resolve({
        data: roles,
        page: { nextCursor: null, hasMore: false },
      } as Page<RoleListItem>);
    }
    return onPatch();
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <RolesPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  // Block body on purpose: a function returned from beforeEach is run by Vitest as a cleanup hook.
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});
afterEach(() => vi.restoreAllMocks());

describe('RolesPage', () => {
  it('offers delete only for unused custom roles, and edit only for custom roles', async () => {
    renderPage(
      [
        role({ id: 'sys', name: 'Viewer', isSystem: true, memberCount: 3 }),
        role({ id: 'used', name: 'Used', memberCount: 2 }),
        role({ id: 'free', name: 'Free' }),
      ],
      () => Promise.resolve(),
    );
    expect(await screen.findByRole('button', { name: 'Open role Viewer' })).toHaveTextContent('View');
    expect(screen.getByRole('button', { name: 'Open role Used' })).toHaveTextContent('Edit');
    expect(screen.queryByRole('button', { name: 'Delete role Viewer' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete role Used' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete role Free' })).toBeInTheDocument();
  });

  it('disables with If-Match from the row, and explains a conflict after reloading', async () => {
    renderPage([role({})], () =>
      Promise.reject(new ApiError(412, { code: 'PRECONDITION_FAILED', status: 412, title: 'x', type: 'x' })),
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Disable role Ops' }));

    await waitFor(() => expect(patchCalls()).toHaveLength(1));
    const [path, init] = patchCalls()[0]!;
    expect(path).toBe('/roles/r1');
    expect(new Headers(init?.headers).get('if-match')).toBe('"5"');
    expect(init?.json).toEqual({ active: false });
    expect(await screen.findByRole('alert')).toHaveTextContent(ROLE_CONFLICT_MESSAGE);
    await waitFor(() => expect(listCalls().length).toBe(2));
  });
});
