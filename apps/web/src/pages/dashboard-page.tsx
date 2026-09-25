import { Card } from '@/components/ui/card';
import { useMe } from '@/lib/me';

export function DashboardPage() {
  const { data: me, isLoading } = useMe();
  if (isLoading || !me) return <p className="text-sm text-slate-500">Loading…</p>;

  return (
    <div className="max-w-3xl space-y-4">
      <h1 className="text-xl font-semibold">Welcome, {me.user.displayName}</h1>
      <Card className="grid gap-4 p-4 sm:grid-cols-3">
        <div>
          <div className="text-xs uppercase text-slate-500">Company</div>
          <div className="font-medium">{me.tenant.name}</div>
        </div>
        <div>
          <div className="text-xs uppercase text-slate-500">Roles</div>
          <div className="font-medium">{me.membership.roles.map((r) => r.name).join(', ') || '—'}</div>
        </div>
        <div>
          <div className="text-xs uppercase text-slate-500">Permissions</div>
          <div className="font-medium">{Object.keys(me.permissions).length}</div>
        </div>
      </Card>
      <p className="text-sm text-slate-500">
        The operations control tower (active campaigns, deadlines, alerts, margins) arrives in milestone M11.
      </p>
    </div>
  );
}
