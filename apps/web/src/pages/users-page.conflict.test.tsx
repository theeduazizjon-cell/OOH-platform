import type { MembershipListItem, Page } from '@ooh/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { api, ApiError } from '@/lib/api';
import type * as MeModule from '@/lib/me';
import { CONFLICT_MESSAGE, UsersPage } from './users-page';

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ session: { tenantId: 't1', membershipId: 'me' } }),
}));
vi.mock('@/lib/me', async (importOriginal) => ({
  ...(await importOriginal<typeof MeModule>()),
  useMe: () => ({
    data: { membership: { id: 'me' }, permissions: { 'users.read': 'ALL', 'users.suspend': 'ALL' } },
  }),
}));

const ana = (version: number): MembershipListItem => ({
  id: 'm-ana',
  userId: 'u-ana',
  displayName: 'Ana',
  email: 'ana@example.com',
  kind: 'INTERNAL',
  status: 'ACTIVE',
  roles: [],
  invitation: null,
  organisation: null,
  version,
});
const page = (member: MembershipListItem): Page<MembershipListItem> => ({
  data: [member],
  page: { nextCursor: null, hasMore: false },
});

type RequestArgs = Parameters<typeof api.request>;
let requestSpy: MockInstance<(...args: RequestArgs) => Promise<unknown>>;
let listVersion: number;

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <UsersPage />
    </QueryClientProvider>,
  );
}

const suspendCalls = () =>
  requestSpy.mock.calls.filter(([path]: RequestArgs) => path.endsWith('/actions/suspend'));

beforeEach(() => {
  listVersion = 3;
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});
afterEach(() => vi.restoreAllMocks());

describe('UsersPage edit conflicts', () => {
  it('sends If-Match with the version of the row it shows', async () => {
    requestSpy = vi
      .spyOn(api, 'request')
      .mockImplementation((path: string) =>
        Promise.resolve(path.startsWith('/memberships?') ? page(ana(listVersion)) : ana(listVersion + 1)),
      );
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Suspend ana@example.com' }));

    await waitFor(() => expect(suspendCalls()).toHaveLength(1));
    const [, init] = suspendCalls()[0]!;
    expect(new Headers(init?.headers).get('if-match')).toBe('"3"');
  });

  it('on 412 explains the conflict and reloads the list with the current version', async () => {
    requestSpy = vi.spyOn(api, 'request').mockImplementation((path: string) => {
      if (path.startsWith('/memberships?')) return Promise.resolve(page(ana(listVersion)));
      listVersion = 4; // someone else changed Ana meanwhile
      return Promise.reject(
        new ApiError(412, {
          code: 'PRECONDITION_FAILED',
          status: 412,
          title: 'Precondition Failed',
          type: 'x',
        }),
      );
    });
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Suspend ana@example.com' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(CONFLICT_MESSAGE);
    // The retry now carries the refreshed version.
    await waitFor(() =>
      expect(
        requestSpy.mock.calls.filter(([path]: RequestArgs) => path.startsWith('/memberships?')).length,
      ).toBe(2),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Suspend ana@example.com' }));
    await waitFor(() => expect(suspendCalls()).toHaveLength(2));
    expect(new Headers(suspendCalls()[1]![1]?.headers).get('if-match')).toBe('"4"');
  });
});
