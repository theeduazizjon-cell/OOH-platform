import type { PermissionKey } from '@ooh/contracts';
import type { ReactNode } from 'react';
import { hasPermission, useMe } from '@/lib/me';
import { NoAccessPage } from '@/pages/placeholder-page';

export function RequirePermission({
  permission,
  children,
}: {
  permission?: PermissionKey;
  children: ReactNode;
}) {
  const { data: me, isLoading } = useMe();
  if (isLoading) return <p className="text-sm text-slate-500">Loading…</p>;
  return hasPermission(me, permission) ? children : <NoAccessPage />;
}
