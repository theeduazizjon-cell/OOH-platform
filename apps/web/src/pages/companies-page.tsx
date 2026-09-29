import {
  type ClassificationItem,
  etagOf,
  IF_MATCH_HEADER,
  type OrganisationDetail,
  type OrganisationListItem,
  type Page,
} from '@ooh/contracts';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useDeferredValue, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Alert, Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { hasPermission, useMe } from '@/lib/me';
import { CompanyForm, type CompanyFormValues } from './company-form';

export const COMPANY_CONFLICT_MESSAGE =
  'Someone else changed this company in the meantime. It has been reloaded; check it and try again.';

type Panel = { kind: 'new' } | { kind: 'open'; id: string } | null;

/** CRM → Companies (docs/architecture/09-screen-map.md): list with search, filter and dedupe on create. */
export function CompaniesPage() {
  const { session } = useAuth();
  const { data: me } = useMe();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [classificationId, setClassificationId] = useState('');
  const [panel, setPanel] = useState<Panel>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const q = useDeferredValue(search.trim());

  const can = {
    create: hasPermission(me, 'organisation.create'),
    update: hasPermission(me, 'organisation.update'),
    archive: hasPermission(me, 'organisation.archive'),
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
  const opened = useQuery({
    queryKey: ['organisation', panel?.kind === 'open' ? panel.id : null],
    queryFn: () => api.request<OrganisationDetail>(`/organisations/${(panel as { id: string }).id}`),
    enabled: panel?.kind === 'open',
  });

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: listKey });
    await queryClient.invalidateQueries({ queryKey: ['organisation'] });
  };

  function open(next: Panel) {
    setNotice(null);
    setPanel(next);
  }

  async function create(values: CompanyFormValues, override?: { forceReason: string }) {
    const created = await api.request<OrganisationDetail>('/organisations', {
      method: 'POST',
      json: { ...values, ...(override ? { force: true, forceReason: override.forceReason } : {}) },
    });
    await refresh();
    open({ kind: 'open', id: created.id });
    setNotice(`${created.displayName} was created.`);
  }

  /** Changes send If-Match; on 412 the company reloads and the form explains why. */
  async function change(company: OrganisationDetail, path: string, json?: unknown) {
    try {
      await api.request<OrganisationDetail>(`/organisations/${company.id}${path}`, {
        method: path ? 'POST' : 'PATCH',
        ...(json === undefined ? {} : { json }),
        headers: { [IF_MATCH_HEADER]: etagOf(company.version) },
      });
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'PRECONDITION_FAILED') {
        await refresh();
        throw new ApiError(caught.status, { ...caught.problem!, detail: COMPANY_CONFLICT_MESSAGE });
      }
      throw caught;
    }
    await refresh();
  }

  async function archive(company: OrganisationDetail) {
    if (!window.confirm(`Archive ${company.displayName}? It disappears from lists but its history is kept.`))
      return;
    try {
      await change(company, '/actions/archive');
      setPanel(null);
      setNotice(`${company.displayName} was archived.`);
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : 'Could not archive the company.');
    }
  }

  const rows = companies.data?.pages.flatMap((p) => p.data) ?? [];
  const company = panel?.kind === 'open' ? opened.data : undefined;
  const classificationList = classifications.data?.data ?? [];

  return (
    <div className="max-w-6xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Companies</h1>
        {can.create && panel?.kind !== 'new' && (
          <Button onClick={() => open({ kind: 'new' })}>New company</Button>
        )}
      </div>

      {notice && (
        <p role="status" className="text-sm text-slate-600">
          {notice}
        </p>
      )}

      {panel?.kind === 'new' && (
        <Card className="p-4">
          <h2 className="mb-3 text-base font-semibold">New company</h2>
          <CompanyForm
            classifications={classificationList}
            submitLabel="Create company"
            onSubmit={create}
            onCancel={() => setPanel(null)}
            onOpenExisting={(id) => open({ kind: 'open', id })}
          />
        </Card>
      )}
      {panel?.kind === 'open' && (
        <Card className="p-4">
          {opened.isLoading && <p className="text-sm text-slate-500">Loading…</p>}
          {opened.error && <Alert>{opened.error.message}</Alert>}
          {company && (
            <>
              <div className="mb-3 flex items-center justify-between gap-3">
                <h2 className="text-base font-semibold">{company.displayName}</h2>
                {can.archive && !company.archivedAt && (
                  <Button variant="ghost" className="text-red-700" onClick={() => void archive(company)}>
                    Archive
                  </Button>
                )}
              </div>
              <CompanyForm
                key={`${company.id}:${company.version}`}
                initial={company}
                classifications={classificationList}
                submitLabel="Save changes"
                onSubmit={async (values) => {
                  await change(company, '', values);
                  setNotice(`${values.displayName} was saved.`);
                }}
                onCancel={() => setPanel(null)}
              />
              {!can.update && (
                <p className="mt-2 text-xs text-slate-500">You can view but not edit companies.</p>
              )}
            </>
          )}
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
                    <button
                      type="button"
                      className="font-medium text-brand-700 hover:underline"
                      onClick={() => open({ kind: 'open', id: o.id })}
                    >
                      {o.displayName}
                    </button>
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
