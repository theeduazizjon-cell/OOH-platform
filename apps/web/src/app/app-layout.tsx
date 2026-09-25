import { Link, Outlet } from '@tanstack/react-router';
import { LogOut, Menu } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import { useAuth } from '@/lib/auth';
import { useMe } from '@/lib/me';
import { visibleNavItems } from './navigation';

function TenantSwitcher() {
  const auth = useAuth();
  const { data: me } = useMe();
  if (!me) return null;
  if (me.memberships.length < 2)
    return <span className="truncate text-sm font-medium">{me.tenant.name}</span>;
  return (
    <select
      aria-label="Company"
      className="h-9 max-w-56 truncate rounded-md border border-slate-300 bg-white px-2 text-sm"
      value={me.tenant.id}
      onChange={(event) => void auth.switchTenant(event.target.value)}
    >
      {me.memberships.map((m) => (
        <option key={m.tenantId} value={m.tenantId}>
          {m.tenantName}
        </option>
      ))}
    </select>
  );
}

export function AppLayout() {
  const auth = useAuth();
  const { data: me } = useMe();
  const [navOpen, setNavOpen] = useState(false);

  return (
    <div className="flex h-full">
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-20 w-60 border-r border-slate-200 bg-white p-3 transition-transform md:static md:translate-x-0',
          navOpen ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="mb-4 px-2 py-1 text-base font-semibold">OOH Platform</div>
        <nav className="space-y-0.5" aria-label="Main">
          {visibleNavItems(me).map((item) => (
            <Link
              key={item.path}
              to={item.path}
              activeOptions={{ exact: item.path === '/app' }}
              onClick={() => setNavOpen(false)}
              className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm text-slate-700 hover:bg-slate-100 data-[status=active]:bg-brand-50 data-[status=active]:font-medium data-[status=active]:text-brand-700"
            >
              <item.icon className="size-4" aria-hidden />
              <span className="flex-1">{item.label}</span>
              {item.milestone && <span className="text-[10px] text-slate-400">{item.milestone}</span>}
            </Link>
          ))}
        </nav>
      </aside>
      {navOpen && (
        <div className="fixed inset-0 z-10 bg-black/20 md:hidden" onClick={() => setNavOpen(false)} />
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center gap-3 border-b border-slate-200 bg-white px-4">
          <Button
            variant="ghost"
            className="px-2 md:hidden"
            aria-label="Open navigation"
            onClick={() => setNavOpen(true)}
          >
            <Menu className="size-5" />
          </Button>
          <TenantSwitcher />
          <div className="ml-auto flex items-center gap-3">
            <span className="hidden text-sm text-slate-600 sm:inline">{me?.user.displayName}</span>
            <Button variant="secondary" onClick={() => void auth.logout()}>
              <LogOut className="size-4" aria-hidden /> Sign out
            </Button>
          </div>
        </header>
        <main className="flex-1 overflow-auto p-4 md:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
