import type { OrganisationListItem, Page } from '@ooh/contracts';
import { useQuery } from '@tanstack/react-query';
import { useDeferredValue, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { api } from '@/lib/api';

export interface PickedCompany {
  id: string;
  displayName: string;
}

/** Search-as-you-type selection of one live company (name or VAT prefix). */
export function CompanyPicker({
  id,
  label,
  value,
  onChange,
  excludeId,
}: {
  id: string;
  label: string;
  value: PickedCompany | null;
  onChange: (company: PickedCompany | null) => void;
  excludeId?: string;
}) {
  const [search, setSearch] = useState('');
  const q = useDeferredValue(search.trim());
  const results = useQuery({
    queryKey: ['organisations', 'picker', q],
    queryFn: () =>
      api.request<Page<OrganisationListItem>>(`/organisations?limit=8&q=${encodeURIComponent(q)}`),
    enabled: value === null && q.length >= 2,
  });

  if (value) {
    return (
      <div className="space-y-1.5">
        <Label htmlFor={id}>{label}</Label>
        <div className="flex items-center gap-2">
          <Input id={id} value={value.displayName} readOnly />
          <Button variant="ghost" className="shrink-0" onClick={() => onChange(null)}>
            Change
          </Button>
        </div>
      </div>
    );
  }
  const options = (results.data?.data ?? []).filter((o) => o.id !== excludeId);
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        placeholder="Type at least 2 letters of the name or VAT"
        value={search}
        onChange={(e) => setSearch(e.currentTarget.value)}
        autoComplete="off"
      />
      {q.length >= 2 && (
        <ul
          role="listbox"
          aria-label={`${label} results`}
          className="rounded-md border border-slate-200 text-sm"
        >
          {results.isLoading && <li className="px-3 py-2 text-slate-500">Searching…</li>}
          {!results.isLoading && options.length === 0 && (
            <li className="px-3 py-2 text-slate-500">No company matches.</li>
          )}
          {options.map((o) => (
            <li key={o.id}>
              <button
                type="button"
                role="option"
                aria-selected={false}
                className="w-full px-3 py-2 text-left hover:bg-slate-50"
                onClick={() => onChange({ id: o.id, displayName: o.displayName })}
              >
                {o.displayName}
                {o.city && <span className="text-slate-500"> · {o.city}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
