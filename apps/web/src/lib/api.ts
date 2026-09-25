import { type AuthSession, CSRF_HEADER, type ProblemDetails } from '@ooh/contracts';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly problem: ProblemDetails | null,
  ) {
    super(problem?.detail ?? problem?.title ?? `Request failed (${status})`);
  }

  get code(): string | undefined {
    return this.problem?.code;
  }
}

async function readProblem(response: Response): Promise<ProblemDetails | null> {
  if (!response.headers.get('content-type')?.includes('json')) return null;
  try {
    return (await response.json()) as ProblemDetails;
  } catch {
    return null;
  }
}

type SessionListener = (session: AuthSession | null) => void;
type RequestOptions = Omit<RequestInit, 'body'> & { json?: unknown };

/** Refresh this long before the access token expires. */
const REFRESH_MARGIN_MS = 60_000;

/**
 * HTTP client for /api/v1. The access token lives only in memory; the refresh token is an httpOnly
 * cookie the browser sends to /api/v1/auth. Refreshes are single-flight per tab and serialised
 * across tabs with the Web Locks API, because the server revokes a session when a rotated
 * refresh token is presented twice.
 */
export class ApiClient {
  private session: AuthSession | null = null;
  private refreshing: Promise<AuthSession | null> | null = null;
  private readonly listeners = new Set<SessionListener>();
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly baseUrl = '/api/v1',
    private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init),
  ) {}

  getSession(): AuthSession | null {
    return this.session;
  }

  onSessionChange(listener: SessionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async request<T>(path: string, options: RequestOptions = {}, allowRetry = true): Promise<T> {
    const { json, headers: initHeaders, ...init } = options;
    const headers = new Headers(initHeaders);
    if (json !== undefined) headers.set('content-type', 'application/json');
    if (this.session) headers.set('authorization', `Bearer ${this.session.accessToken}`);

    const response = await this.fetchImpl(this.baseUrl + path, {
      ...init,
      headers,
      credentials: 'same-origin',
      ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
    });

    if (response.status === 401 && this.session) {
      const problem = await readProblem(response.clone());
      if (problem?.code === 'TOKEN_EXPIRED' && allowRetry) {
        if (await this.refresh()) return this.request<T>(path, options, false);
      } else if (problem?.code !== 'TOKEN_EXPIRED') {
        this.setSession(null); // session revoked or invalid: back to sign-in
      }
    }
    if (!response.ok) throw new ApiError(response.status, await readProblem(response));
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  async login(email: string, password: string): Promise<AuthSession> {
    const session = await this.request<AuthSession>(
      '/auth/login',
      { method: 'POST', json: { email, password } },
      false,
    );
    this.setSession(session);
    return session;
  }

  /** Exchanges the refresh cookie for a new access token. Resolves null when the session is over. */
  refresh(): Promise<AuthSession | null> {
    this.refreshing ??= this.withCrossTabLock(async () => {
      const response = await this.fetchImpl(`${this.baseUrl}/auth/refresh`, {
        method: 'POST',
        headers: { [CSRF_HEADER]: '1' },
        credentials: 'same-origin',
      });
      const session = response.ok ? ((await response.json()) as AuthSession) : null;
      this.setSession(session);
      return session;
    })
      .catch(() => {
        this.setSession(null);
        return null;
      })
      .finally(() => {
        this.refreshing = null;
      });
    return this.refreshing;
  }

  async logout(): Promise<void> {
    try {
      await this.fetchImpl(`${this.baseUrl}/auth/logout`, {
        method: 'POST',
        headers: { [CSRF_HEADER]: '1' },
        credentials: 'same-origin',
      });
    } finally {
      this.setSession(null);
    }
  }

  async switchTenant(tenantId: string): Promise<AuthSession> {
    const session = await this.request<AuthSession>('/auth/switch-tenant', {
      method: 'POST',
      json: { tenantId },
      headers: { [CSRF_HEADER]: '1' },
    });
    this.setSession(session);
    return session;
  }

  private setSession(session: AuthSession | null): void {
    this.session = session;
    clearTimeout(this.refreshTimer);
    if (session) {
      const delay = new Date(session.accessTokenExpiresAt).getTime() - Date.now() - REFRESH_MARGIN_MS;
      this.refreshTimer = setTimeout(() => void this.refresh(), Math.max(delay, 5_000));
    }
    for (const listener of this.listeners) listener(session);
  }

  private withCrossTabLock<T>(fn: () => Promise<T>): Promise<T> {
    const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
    if (!locks) return fn();
    // lib.dom types the result as Promise<Promise<T>>; the platform flattens it (it's a promise chain).
    return locks.request('ooh-auth-refresh', fn) as unknown as Promise<T>;
  }
}

export const api = new ApiClient();
