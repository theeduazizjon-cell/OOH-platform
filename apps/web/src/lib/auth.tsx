import type { AuthSession } from '@ooh/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from 'react';
import { api } from './api';

export type AuthStatus = 'loading' | 'authenticated' | 'anonymous';

export interface AuthContextValue {
  status: AuthStatus;
  session: AuthSession | null;
  login(email: string, password: string): Promise<void>;
  logout(): Promise<void>;
  switchTenant(tenantId: string): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/** Restores the session from the refresh cookie on load, then tracks it. */
export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [session, setSession] = useState<AuthSession | null>(api.getSession());
  const [restored, setRestored] = useState(false);

  useEffect(() => {
    const unsubscribe = api.onSessionChange((next) => {
      setSession(next);
      // Data is per tenant and per user: never show cached data from another session.
      if (!next) queryClient.clear();
    });
    void api.refresh().finally(() => setRestored(true));
    return unsubscribe;
  }, [queryClient]);

  const value = useMemo<AuthContextValue>(
    () => ({
      status: !restored ? 'loading' : session ? 'authenticated' : 'anonymous',
      session,
      login: async (email, password) => {
        await api.login(email, password);
      },
      logout: () => api.logout(),
      switchTenant: async (tenantId) => {
        await api.switchTenant(tenantId);
        queryClient.clear();
      },
    }),
    [restored, session, queryClient],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside <AuthProvider>');
  return value;
}
