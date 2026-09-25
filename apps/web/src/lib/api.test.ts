import type { AuthSession } from '@ooh/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiError } from './api';

const session = (token: string): AuthSession => ({
  accessToken: token,
  accessTokenExpiresAt: new Date(Date.now() + 600_000).toISOString(),
  tenantId: 't',
  membershipId: 'm',
});

const json = (status: number, body: unknown, contentType = 'application/json') =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': contentType } });
const problem = (status: number, code: string) =>
  json(status, { status, code, title: code, type: 'x' }, 'application/problem+json');

const urlOf = (input: RequestInfo | URL) =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

afterEach(() => vi.useRealTimers());

describe('ApiClient', () => {
  it('sends the bearer token and parses JSON', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(200, session('A')))
      .mockResolvedValueOnce(json(200, { ok: 1 }));
    const client = new ApiClient('/api/v1', fetchImpl);
    await client.login('a@b.c', 'pw');
    await expect(client.request('/me')).resolves.toEqual({ ok: 1 });
    const headers = new Headers(fetchImpl.mock.calls[1]![1]!.headers);
    expect(headers.get('authorization')).toBe('Bearer A');
  });

  it('refreshes ONCE for concurrent TOKEN_EXPIRED responses, then retries each request', async () => {
    let refreshCalls = 0;
    const fetchImpl = vi.fn<typeof fetch>((input, init) => {
      const url = urlOf(input);
      if (url.endsWith('/auth/login')) return Promise.resolve(json(200, session('old')));
      if (url.endsWith('/auth/refresh')) {
        refreshCalls++;
        expect(new Headers(init?.headers).get('x-ooh-csrf')).toBe('1');
        return Promise.resolve(json(200, session('new')));
      }
      const auth = new Headers(init?.headers).get('authorization');
      return Promise.resolve(auth === 'Bearer new' ? json(200, { url }) : problem(401, 'TOKEN_EXPIRED'));
    });
    const client = new ApiClient('/api/v1', fetchImpl);
    await client.login('a@b.c', 'pw');

    const results = await Promise.all([
      client.request('/one'),
      client.request('/two'),
      client.request('/three'),
    ]);
    expect(results).toHaveLength(3);
    expect(refreshCalls).toBe(1);
    expect(client.getSession()?.accessToken).toBe('new');
  });

  it('ends the session when the server says it is no longer valid', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(200, session('A')))
      .mockResolvedValueOnce(problem(401, 'UNAUTHENTICATED'));
    const client = new ApiClient('/api/v1', fetchImpl);
    const listener = vi.fn();
    await client.login('a@b.c', 'pw');
    client.onSessionChange(listener);

    const error = await client.request('/me').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('UNAUTHENTICATED');
    expect(client.getSession()).toBeNull();
    expect(listener).toHaveBeenCalledWith(null);
  });

  it('resolves refresh() to null when there is no valid cookie', async () => {
    const client = new ApiClient(
      '/api/v1',
      vi.fn<typeof fetch>().mockResolvedValue(problem(401, 'UNAUTHENTICATED')),
    );
    await expect(client.refresh()).resolves.toBeNull();
  });

  it('proactively refreshes shortly before the access token expires', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>((input) =>
      Promise.resolve(
        urlOf(input).endsWith('/auth/refresh') ? json(200, session('renewed')) : json(200, session('first')),
      ),
    );
    const client = new ApiClient('/api/v1', fetchImpl);
    await client.login('a@b.c', 'pw');
    await vi.advanceTimersByTimeAsync(600_000 - 60_000 + 10);
    expect(fetchImpl.mock.calls.some(([input]) => urlOf(input).endsWith('/auth/refresh'))).toBe(true);
    expect(client.getSession()?.accessToken).toBe('renewed');
  });
});
