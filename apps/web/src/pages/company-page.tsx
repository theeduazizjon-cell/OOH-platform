import {
  type AccountOwnerCandidate,
  type ActivityItem,
  type ClassificationItem,
  type ContactListItem,
  etagOf,
  IF_MATCH_HEADER,
  type OpportunityListItem,
  type OrganisationDetail,
  type Page,
  type TaskItem,
} from '@ooh/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { type ReactNode, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Alert, Card } from '@/components/ui/card';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { hasPermission, useMe } from '@/lib/me';
import { ActivityTimeline, formatWhen } from './activity-timeline';
import { CompanyContacts } from './company-contacts';
import { CompanyForm } from './company-form';
import { CompanyOpportunities } from './company-opportunities';
import { CompanyRelationships } from './company-relationships';
import { CrmTabs } from './crm-tabs';
import { totalsByCurrency } from './pipeline';
import { taskQuery, TaskList } from './task-list';
import { formatDue } from './tasks';

export const COMPANY_CONFLICT_MESSAGE =
  'Someone else changed this company in the meantime. It has been reloaded; check it and try again.';

/** The headline numbers of the 360° (computed from lists the sections load anyway). */
export function companySummary(input: {
  opportunities: readonly OpportunityListItem[];
  tasks: readonly TaskItem[];
  activities: readonly ActivityItem[];
}) {
  const open = input.opportunities.filter((o) => o.stage.kind === 'OPEN');
  return {
    openOpportunities: open.length,
    pipelineValue: totalsByCurrency(open),
    won: input.opportunities.filter((o) => o.stage.kind === 'WON').length,
    nextTask: input.tasks[0] ?? null,
    lastActivity: input.activities[0] ?? null,
  };
}

/**
 * Company 360° v1 (docs/architecture/09-screen-map.md): the company at a glance, then its contacts,
 * opportunities, tasks, relationships and timeline. Campaigns, revenue/GM and documents join as
 * their modules ship (M3, M4, M11).
 */
export function CompanyPage({ companyId }: { companyId: string }) {
  const { session } = useAuth();
  const { data: me } = useMe();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const can = {
    update: hasPermission(me, 'organisation.update'),
    archive: hasPermission(me, 'organisation.archive'),
    readConfig: hasPermission(me, 'config.read'),
  };

  const company = useQuery({
    queryKey: ['organisation', companyId],
    queryFn: () => api.request<OrganisationDetail>(`/organisations/${companyId}`),
  });
  const classifications = useQuery({
    queryKey: ['classifications', session?.tenantId],
    queryFn: () => api.request<Page<ClassificationItem>>('/config/classifications'),
    enabled: can.readConfig && editing,
  });
  const accountOwners = useQuery({
    queryKey: ['account-owners', session?.tenantId],
    queryFn: () => api.request<AccountOwnerCandidate[]>('/organisations/account-owners'),
    enabled: can.update && editing,
  });
  // The same queries (and cache keys) as the sections below, so the summary costs no extra request.
  const opportunities = useQuery({
    queryKey: ['opportunities', 'organisation', companyId],
    queryFn: () =>
      api.request<Page<OpportunityListItem>>(`/opportunities?organisationId=${companyId}&limit=100`),
    enabled: hasPermission(me, 'opportunity.read'),
  });
  const contacts = useQuery({
    queryKey: ['contacts', 'organisation', companyId],
    queryFn: () => api.request<Page<ContactListItem>>(`/contacts?organisationId=${companyId}&limit=100`),
    enabled: hasPermission(me, 'contact.read'),
  });
  const tasks = useQuery({
    queryKey: ['tasks', taskQuery({ organisationId: companyId })],
    queryFn: () => api.request<Page<TaskItem>>(`/tasks?${taskQuery({ organisationId: companyId })}`),
    enabled: hasPermission(me, 'task.read'),
  });
  const activities = useQuery({
    queryKey: ['activities', `organisationId=${companyId}`],
    queryFn: () => api.request<Page<ActivityItem>>(`/activities?organisationId=${companyId}&limit=50`),
    enabled: hasPermission(me, 'activity.read'),
  });

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['organisations'] });
    await queryClient.invalidateQueries({ queryKey: ['organisation'] });
  };

  /** Changes send If-Match; on 412 the company reloads and the form explains why. */
  async function change(o: OrganisationDetail, path: string, json?: unknown) {
    try {
      await api.request<OrganisationDetail>(`/organisations/${o.id}${path}`, {
        method: path ? 'POST' : 'PATCH',
        ...(json === undefined ? {} : { json }),
        headers: { [IF_MATCH_HEADER]: etagOf(o.version) },
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

  async function archive(o: OrganisationDetail) {
    if (!window.confirm(`Archive ${o.displayName}? It disappears from lists but its history is kept.`))
      return;
    try {
      await change(o, '/actions/archive');
      await navigate({ to: '/app/crm/companies' });
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : 'Could not archive the company.');
    }
  }

  const back = (
    <Link to="/app/crm/companies" className="text-sm text-brand-700 hover:underline">
      ← Companies
    </Link>
  );
  if (company.isLoading) return <p className="text-sm text-slate-500">Loading…</p>;
  if (company.error || !company.data) {
    return (
      <div className="max-w-6xl space-y-3">
        {back}
        <Alert>{company.error?.message ?? 'Company not found.'}</Alert>
      </div>
    );
  }
  const c = company.data;
  const archived = Boolean(c.archivedAt);
  const summary = companySummary({
    opportunities: opportunities.data?.data ?? [],
    tasks: tasks.data?.data ?? [],
    activities: activities.data?.data ?? [],
  });

  return (
    <div className="max-w-6xl space-y-4">
      <CrmTabs />
      {back}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">
            {c.displayName}
            {archived && <span className="ml-2 text-sm font-normal text-slate-500">(archived)</span>}
          </h1>
          <p className="text-sm text-slate-600">
            {[
              c.legalName,
              c.vatNumber,
              c.city,
              c.accountOwner && `Account owner: ${c.accountOwner.displayName}`,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
          <span className="mt-1 flex flex-wrap gap-1">
            {c.classifications.map((k) => (
              <span key={k.id} className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-700">
                {k.name}
              </span>
            ))}
          </span>
        </div>
        <span className="flex gap-2">
          {can.update && !archived && !editing && (
            <Button variant="secondary" onClick={() => setEditing(true)}>
              Edit details
            </Button>
          )}
          {can.archive && !archived && (
            <Button variant="ghost" className="text-red-700" onClick={() => void archive(c)}>
              Archive
            </Button>
          )}
        </span>
      </div>

      {notice && (
        <p role="status" className="text-sm text-slate-600">
          {notice}
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Open opportunities" visible={opportunities.isSuccess}>
          {summary.openOpportunities}
          {summary.pipelineValue && (
            <span className="block text-xs text-slate-500">{summary.pipelineValue}</span>
          )}
        </Stat>
        <Stat label="Next task" visible={tasks.isSuccess}>
          {summary.nextTask ? (
            <>
              <span className="block truncate text-sm">{summary.nextTask.title}</span>
              <span className="block text-xs text-slate-500">
                {summary.nextTask.dueAt ? `Due ${formatDue(summary.nextTask.dueAt)}` : 'No due date'}
              </span>
            </>
          ) : (
            <span className="text-sm text-slate-500">None open</span>
          )}
        </Stat>
        <Stat label="Contacts" visible={contacts.isSuccess}>
          {contacts.data?.data.length ?? 0}
        </Stat>
        <Stat label="Latest activity" visible={activities.isSuccess}>
          {summary.lastActivity ? (
            <>
              <span className="block truncate text-sm">{summary.lastActivity.subject}</span>
              <span className="block text-xs text-slate-500">
                {formatWhen(summary.lastActivity.occurredAt)}
              </span>
            </>
          ) : (
            <span className="text-sm text-slate-500">Nothing logged</span>
          )}
        </Stat>
      </div>

      {editing && (
        <Card className="p-4">
          <h2 className="mb-3 text-base font-semibold">Details</h2>
          <CompanyForm
            key={`${c.id}:${c.version}`}
            initial={c}
            classifications={classifications.data?.data ?? []}
            accountOwners={accountOwners.data}
            submitLabel="Save changes"
            onSubmit={async (values) => {
              await change(c, '', values);
              setEditing(false);
              setNotice(`${values.displayName} was saved.`);
            }}
            onCancel={() => setEditing(false)}
          />
        </Card>
      )}

      <div className="grid gap-x-8 *:min-w-0 lg:grid-cols-2">
        <CompanyOpportunities organisation={c} archived={archived} />
        <section className="mt-6 border-t border-slate-200 pt-4">
          <TaskList
            title="Tasks"
            filter={{ organisationId: c.id }}
            canAdd={!archived}
            showSubject={false}
            emptyText="No open tasks."
          />
        </section>
        <CompanyContacts organisationId={c.id} archived={archived} />
        <CompanyRelationships organisationId={c.id} archived={archived} />
      </div>
      <ActivityTimeline organisationId={c.id} archived={archived} />
    </div>
  );
}

function Stat({ label, visible, children }: { label: string; visible: boolean; children: ReactNode }) {
  if (!visible) return null;
  return (
    <Card className="p-3">
      <p className="text-xs uppercase text-slate-500">{label}</p>
      <div className="text-lg font-semibold">{children}</div>
    </Card>
  );
}
