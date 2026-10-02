import { Link } from '@tanstack/react-router';
import { hasPermission, useMe } from '@/lib/me';

/** CRM sub-navigation (docs/architecture/09-screen-map.md: Companies, Contacts, Pipeline). */
export function CrmTabs() {
  const { data: me } = useMe();
  const tabs = [
    {
      to: '/app/crm/companies' as const,
      label: 'Companies',
      visible: hasPermission(me, 'organisation.read'),
    },
    { to: '/app/crm/contacts' as const, label: 'Contacts', visible: hasPermission(me, 'contact.read') },
    {
      to: '/app/crm/pipeline' as const,
      label: 'Pipeline',
      visible: hasPermission(me, 'opportunity.read') && hasPermission(me, 'config.read'),
    },
  ].filter((tab) => tab.visible);
  if (tabs.length < 2) return null;
  return (
    <nav aria-label="CRM" className="flex gap-1 border-b border-slate-200">
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
