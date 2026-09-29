import type { ContactListItem, Page } from '@ooh/contracts';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useDeferredValue, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { ContactPanel } from './contact-panel';
import { ContactsTable } from './contacts-table';
import { CrmTabs } from './crm-tabs';

/** CRM → Contacts: every contact across companies. New contacts are added from their company. */
export function ContactsPage() {
  const { session } = useAuth();
  const [search, setSearch] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const q = useDeferredValue(search.trim());

  const contacts = useInfiniteQuery({
    queryKey: ['contacts', 'all', session?.tenantId, q],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: '50' });
      if (q) params.set('q', q);
      if (pageParam) params.set('cursor', pageParam);
      return api.request<Page<ContactListItem>>(`/contacts?${params.toString()}`);
    },
    getNextPageParam: (last) => last.page.nextCursor,
  });
  const rows = contacts.data?.pages.flatMap((p) => p.data) ?? [];

  return (
    <div className="max-w-6xl space-y-4">
      <CrmTabs />
      <h1 className="text-xl font-semibold">Contacts</h1>
      {openId && (
        <ContactPanel key={openId} target={{ kind: 'open', id: openId }} onClose={() => setOpenId(null)} />
      )}
      <Input
        aria-label="Search contacts"
        placeholder="Search by name or email"
        className="max-w-sm"
        value={search}
        onChange={(e) => setSearch(e.currentTarget.value)}
      />
      {contacts.isLoading && <p className="text-sm text-slate-500">Loading…</p>}
      {contacts.error && <p className="text-sm text-red-700">{contacts.error.message}</p>}
      {contacts.data && (
        <Card className="overflow-x-auto">
          <ContactsTable
            contacts={rows}
            showCompany
            onOpen={setOpenId}
            emptyText={q ? 'No contacts match.' : 'No contacts yet. Add them from their company.'}
          />
        </Card>
      )}
      {contacts.hasNextPage && (
        <Button
          variant="secondary"
          disabled={contacts.isFetchingNextPage}
          onClick={() => void contacts.fetchNextPage()}
        >
          {contacts.isFetchingNextPage ? 'Loading…' : 'Show more'}
        </Button>
      )}
    </div>
  );
}
