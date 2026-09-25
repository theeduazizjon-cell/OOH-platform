import type { MembershipListItem, Page } from '@ooh/contracts';
import { useQuery } from '@tanstack/react-query';
import { Card } from '@/components/ui/card';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';

export function UsersPage() {
  const { session } = useAuth();
  const { data, isLoading, error } = useQuery({
    queryKey: ['memberships', session?.tenantId],
    queryFn: () => api.request<Page<MembershipListItem>>('/memberships?limit=100'),
  });

  return (
    <div className="max-w-5xl space-y-4">
      <h1 className="text-xl font-semibold">Users</h1>
      {isLoading && <p className="text-sm text-slate-500">Loading…</p>}
      {error && <p className="text-sm text-red-700">{error.message}</p>}
      {data && (
        <Card className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase text-slate-500">
              <tr>
                <th className="px-4 py-2">Name</th>
                <th className="px-4 py-2">Email</th>
                <th className="px-4 py-2">Type</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Roles</th>
              </tr>
            </thead>
            <tbody>
              {data.data.map((m) => (
                <tr key={m.id} className="border-b border-slate-100 last:border-0">
                  <td className="px-4 py-2 font-medium">{m.displayName}</td>
                  <td className="px-4 py-2">{m.email}</td>
                  <td className="px-4 py-2">{m.kind === 'INTERNAL' ? 'Internal' : 'External'}</td>
                  <td className="px-4 py-2">{m.status}</td>
                  <td className="px-4 py-2">{m.roles.map((r) => r.name).join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      <p className="text-sm text-slate-500">Inviting users and editing roles comes next in milestone M1.</p>
    </div>
  );
}
