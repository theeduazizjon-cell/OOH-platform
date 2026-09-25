import type { MeResponse, PermissionKey } from '@ooh/contracts';
import {
  BarChart3,
  Briefcase,
  CalendarDays,
  CheckSquare,
  Coins,
  Inbox,
  LayoutDashboard,
  type LucideIcon,
  Map as MapIcon,
  Megaphone,
  Settings,
  Truck,
  Warehouse,
} from 'lucide-react';
import { hasPermission } from '@/lib/me';

export interface NavItem {
  readonly label: string;
  readonly path: string;
  readonly icon: LucideIcon;
  readonly permission?: PermissionKey;
  /** Roadmap milestone that delivers the module (docs/architecture/12-roadmap.md); undefined = available. */
  readonly milestone?: string;
}

/** Flattened navigation from docs/architecture/09-screen-map.md. */
export const NAV_ITEMS: readonly NavItem[] = [
  { label: 'Dashboard', path: '/app', icon: LayoutDashboard, permission: 'dashboard.read' },
  { label: 'Requests', path: '/app/requests', icon: Inbox, permission: 'brief.read', milestone: 'M3' },
  {
    label: 'Campaigns',
    path: '/app/campaigns',
    icon: Megaphone,
    permission: 'campaign.read',
    milestone: 'M3',
  },
  { label: 'Map', path: '/app/map', icon: MapIcon, permission: 'asset.read', milestone: 'M5' },
  { label: 'Inventory', path: '/app/inventory', icon: Warehouse, permission: 'asset.read', milestone: 'M4' },
  {
    label: 'Operations',
    path: '/app/operations',
    icon: Truck,
    permission: 'field_job.read',
    milestone: 'M8–M10',
  },
  {
    label: 'Calendar',
    path: '/app/calendar',
    icon: CalendarDays,
    permission: 'calendar.read',
    milestone: 'M11',
  },
  { label: 'Tasks', path: '/app/tasks', icon: CheckSquare, permission: 'task.read', milestone: 'M2' },
  { label: 'CRM', path: '/app/crm', icon: Briefcase, permission: 'organisation.read', milestone: 'M2' },
  {
    label: 'Commercial',
    path: '/app/commercial',
    icon: Coins,
    permission: 'tariff.read',
    milestone: 'M8, M11',
  },
  { label: 'Reports', path: '/app/reports', icon: BarChart3, permission: 'report.read', milestone: 'M12' },
  { label: 'Admin', path: '/app/admin/users', icon: Settings, permission: 'users.read' },
];

export function visibleNavItems(me: MeResponse | undefined): NavItem[] {
  return NAV_ITEMS.filter((item) => hasPermission(me, item.permission));
}
