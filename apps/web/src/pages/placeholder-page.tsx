import { Card } from '@/components/ui/card';
import type { NavItem } from '@/app/navigation';

export function PlaceholderPage({ item }: { item: NavItem }) {
  return (
    <Card className="max-w-xl p-6">
      <h1 className="text-lg font-semibold">{item.label}</h1>
      <p className="mt-1 text-sm text-slate-600">
        This module is delivered in milestone <strong>{item.milestone}</strong> of the engineering roadmap
        (docs/architecture/12-roadmap.md).
      </p>
    </Card>
  );
}

export function NoAccessPage() {
  return (
    <Card className="max-w-xl p-6">
      <h1 className="text-lg font-semibold">No access</h1>
      <p className="mt-1 text-sm text-slate-600">
        Your role does not include this area. Ask your company admin.
      </p>
    </Card>
  );
}
