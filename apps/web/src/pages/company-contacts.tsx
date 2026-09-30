import type { ContactListItem, Page } from '@ooh/contracts';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { hasPermission, useMe } from '@/lib/me';
import { ContactPanel, type ContactTarget } from './contact-panel';
import { ContactsTable } from './contacts-table';

/** The Contacts section of a company. */
export function CompanyContacts({ organisationId, archived }: { organisationId: string; archived: boolean }) {
  const { data: me } = useMe();
  const [target, setTarget] = useState<ContactTarget | null>(null);
  const canRead = hasPermission(me, 'contact.read');
  const contacts = useQuery({
    queryKey: ['contacts', 'organisation', organisationId],
    queryFn: () => api.request<Page<ContactListItem>>(`/contacts?organisationId=${organisationId}&limit=100`),
    enabled: canRead,
  });
  if (!canRead) return null;

  return (
    <section className="mt-6 space-y-3 border-t border-slate-200 pt-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">Contacts</h3>
        {hasPermission(me, 'contact.create') && !archived && target?.kind !== 'new' && (
          <Button
            variant="secondary"
            className="h-8"
            onClick={() => setTarget({ kind: 'new', organisationId })}
          >
            Add contact
          </Button>
        )}
      </div>
      {target && (
        <ContactPanel key={JSON.stringify(target)} target={target} onClose={() => setTarget(null)} />
      )}
      {contacts.error && <p className="text-sm text-red-700">{contacts.error.message}</p>}
      {contacts.data && (
        <div className="overflow-x-auto rounded-md border border-slate-200">
          <ContactsTable
            contacts={contacts.data.data}
            showCompany={false}
            onOpen={(id) => setTarget({ kind: 'open', id })}
            emptyText="No contacts yet."
          />
        </div>
      )}
    </section>
  );
}
