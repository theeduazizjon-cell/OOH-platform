import type { MeResponse, PermissionKey } from '@ooh/contracts';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import { useAuth } from './auth';

export function useMe() {
  const { session } = useAuth();
  return useQuery({
    queryKey: ['me', session?.tenantId, session?.membershipId],
    queryFn: () => api.request<MeResponse>('/me'),
    enabled: session !== null,
    staleTime: 60_000,
  });
}

/** UI convenience only: the API enforces every permission regardless of what the UI shows. */
export function hasPermission(me: MeResponse | undefined, permission: PermissionKey | undefined): boolean {
  if (!permission) return true;
  return Boolean(me?.permissions[permission]);
}
