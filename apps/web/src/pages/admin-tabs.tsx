import { Link } from '@tanstack/react-router';
import { hasPermission, useMe } from '@/lib/me';

/** Admin sub-navigation (docs/architecture/09-screen-map.md: Admin → Users, Roles & Permissions). */
export function AdminTabs() {
  const { data: me } = useMe();
  const tabs = [
    { to: '/app/admin/users' as const, label: 'Users', visible: hasPermission(me, 'users.read') },
    { to: '/app/admin/roles' as const, label: 'Roles', visible: hasPermission(me, 'roles.read') },
  ].filter((tab) => tab.visible);
  if (tabs.length < 2) return null;
  return (
    <nav aria-label="Admin" className="flex gap-1 border-b border-slate-200">
      {tabs.map((tab) => (
        <Link
          key={tab.to}
          to={tab.to}
          className="-mb-px border-b-2 border-transparent px-3 py-2 text-sm text-slate-600 hover:text-slate-900"
          activeProps={{ className: 'border-brand-600 font-medium text-slate-900' }}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
