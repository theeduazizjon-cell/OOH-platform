import {
  type AccountOwnerCandidate,
  type ClassificationItem,
  type OrganisationDetail,
  type OrganisationListItem,
  type Page,
} from '@ooh/contracts';
import { Link, useNavigate } from '@tanstack/react-router';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useDeferredValue, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { hasPermission, useMe } from '@/lib/me';
import { CompanyForm, type CompanyFormValues } from './company-form';
import { CrmTabs } from './crm-tabs';

/**
 * CRM → Companies (docs/architecture/09-screen-map.md): list with search, filter and dedupe on create.
 * A company opens on its own 360° page.
 */
export function CompaniesPage() {
  const { session } = useAuth();
  const { data: me } = useMe();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [classificationId, setClassificationId] = useState('');
  const [creating, setCreating] = useState(false);
  const q = useDeferredValue(search.trim());

  const can = {
    create: hasPermission(me, 'organisation.create'),
    update: hasPermission(me, 'organisation.update'),
    readConfig: hasPermission(me, 'config.read'),
  };
  const listKey = ['organisations', session?.tenantId];

  const classifications = useQuery({
    queryKey: ['classifications', session?.tenantId],
    queryFn: () => api.request<Page<ClassificationItem>>('/config/classifications'),
    enabled: can.readConfig,
  });
  const companies = useInfiniteQuery({
    queryKey: [...listKey, q, classificationId],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: '50' });
      if (q) params.set('q', q);
      if (classificationId) params.set('classificationId', classificationId);
      if (pageParam) params.set('cursor', pageParam);
      return api.request<Page<OrganisationListItem>>(`/organisations?${params.toString()}`);
    },
    getNextPageParam: (last) => last.page.nextCursor,
  });
  const accountOwners = useQuery({
    queryKey: ['account-owners', session?.tenantId],
    queryFn: () => api.request<AccountOwnerCandidate[]>('/organisations/account-owners'),
    enabled: can.update && creating,
  });
  const openCompany = (id: string) =>
    navigate({ to: '/app/crm/companies/$companyId', params: { companyId: id } });

  async function create(values: CompanyFormValues, override?: { forceReason: string }) {
    const created = await api.request<OrganisationDetail>('/organisations', {
      method: 'POST',
      json: { ...values, ...(override ? { force: true, forceReason: override.forceReason } : {}) },
    });
    await queryClient.invalidateQueries({ queryKey: listKey });
    await openCompany(created.id);
  }

  const rows = companies.data?.pages.flatMap((p) => p.data) ?? [];
  const classificationList = classifications.data?.data ?? [];

  return (
    <div className="max-w-6xl space-y-4">
      <CrmTabs />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Companies</h1>
        {can.create && !creating && <Button onClick={() => setCreating(true)}>New company</Button>}
      </div>

      {creating && (
        <Card className="p-4">
          <h2 className="mb-3 text-base font-semibold">New company</h2>
          <CompanyForm
            classifications={classificationList}
            accountOwners={accountOwners.data}
            submitLabel="Create company"
            onSubmit={create}
            onCancel={() => setCreating(false)}
            onOpenExisting={(id) => void openCompany(id)}
          />
        </Card>
      )}

      <div className="flex flex-wrap gap-3">
        <Input
          aria-label="Search companies"
          placeholder="Search by name or VAT number"
          className="max-w-sm"
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
        />
        {can.readConfig && (
          <select
            aria-label="Filter by classification"
            className="h-9 rounded-md border border-slate-300 bg-white px-3 text-sm"
            value={classificationId}
            onChange={(e) => setClassificationId(e.currentTarget.value)}
          >
            <option value="">All classifications</option>
            {classificationList.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        )}
      </div>

      {companies.isLoading && <p className="text-sm text-slate-500">Loading…</p>}
      {companies.error && <p className="text-sm text-red-700">{companies.error.message}</p>}
      {companies.data && (
        <Card className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase text-slate-500">
              <tr>
                <th className="px-4 py-2">Company</th>
                <th className="px-4 py-2">VAT</th>
                <th className="px-4 py-2">City</th>
                <th className="px-4 py-2">Classifications</th>
                <th className="px-4 py-2">Account owner</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-slate-500">
                    {q || classificationId ? 'No companies match.' : 'No companies yet.'}
                  </td>
                </tr>
              )}
              {rows.map((o) => (
                <tr key={o.id} className="border-b border-slate-100 last:border-0">
                  <td className="px-4 py-2">
                    <Link
                      to="/app/crm/companies/$companyId"
                      params={{ companyId: o.id }}
                      className="font-medium text-brand-700 hover:underline"
                    >
                      {o.displayName}
                    </Link>
                    {o.legalName && <span className="block text-xs text-slate-500">{o.legalName}</span>}
                  </td>
                  <td className="px-4 py-2">{o.vatNumber}</td>
                  <td className="px-4 py-2">{o.city}</td>
                  <td className="px-4 py-2">
                    <span className="flex flex-wrap gap-1">
                      {o.classifications.map((c) => (
                        <span
                          key={c.id}
                          className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-700"
                        >
                          {c.name}
                        </span>
                      ))}
                    </span>
                  </td>
                  <td className="px-4 py-2">{o.accountOwner?.displayName}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      {companies.hasNextPage && (
        <Button
          variant="secondary"
          disabled={companies.isFetchingNextPage}
          onClick={() => void companies.fetchNextPage()}
        >
          {companies.isFetchingNextPage ? 'Loading…' : 'Show more'}
        </Button>
      )}
    </div>
  );
}
