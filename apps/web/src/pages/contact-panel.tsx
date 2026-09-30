import { type ContactDetail, etagOf, IF_MATCH_HEADER } from '@ooh/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Alert, Card } from '@/components/ui/card';
import { api, ApiError } from '@/lib/api';
import { hasPermission, useMe } from '@/lib/me';
import { ContactForm, type ContactFormValues } from './contact-form';

export const CONTACT_CONFLICT_MESSAGE =
  'Someone else changed this contact in the meantime. It has been reloaded; check it and try again.';

export type ContactTarget = { kind: 'new'; organisationId: string } | { kind: 'open'; id: string };

/** Create or edit one contact, with archive and GDPR anonymisation. */
export function ContactPanel({ target, onClose }: { target: ContactTarget; onClose: () => void }) {
  const { data: me } = useMe();
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);
  const can = {
    create: hasPermission(me, 'contact.create'),
    update: hasPermission(me, 'contact.update'),
    archive: hasPermission(me, 'contact.archive'),
    anonymise: hasPermission(me, 'contact.anonymise'),
  };

  const opened = useQuery({
    queryKey: ['contact', target.kind === 'open' ? target.id : null],
    queryFn: () => api.request<ContactDetail>(`/contacts/${(target as { id: string }).id}`),
    enabled: target.kind === 'open',
  });

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['contacts'] });
    await queryClient.invalidateQueries({ queryKey: ['contact'] });
  };

  /** Changes send If-Match; on 412 the contact reloads and the error explains why. */
  async function change(person: ContactDetail, path: string, json?: ContactFormValues) {
    try {
      await api.request<ContactDetail>(`/contacts/${person.id}${path}`, {
        method: path ? 'POST' : 'PATCH',
        ...(json ? { json } : {}),
        headers: { [IF_MATCH_HEADER]: etagOf(person.version) },
      });
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'PRECONDITION_FAILED') {
        await refresh();
        throw new ApiError(caught.status, { ...caught.problem!, detail: CONTACT_CONFLICT_MESSAGE });
      }
      throw caught;
    }
    await refresh();
  }

  async function runAction(person: ContactDetail, action: 'archive' | 'anonymise') {
    const question =
      action === 'archive'
        ? `Archive ${person.firstName}? The contact is hidden from lists but kept.`
        : `Anonymise ${person.firstName} ${person.lastName ?? ''}? Their personal data is erased permanently ` +
          'and they are never contacted again. This cannot be undone.';
    if (!window.confirm(question)) return;
    try {
      await change(person, `/actions/${action}`);
      setNotice(action === 'archive' ? 'Contact archived.' : 'Contact anonymised: personal data erased.');
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : 'The action failed.');
    }
  }

  if (target.kind === 'new') {
    return (
      <Card className="p-4">
        <h3 className="mb-3 text-sm font-semibold">New contact</h3>
        <ContactForm
          submitLabel="Add contact"
          onSubmit={async (values) => {
            await api.request<ContactDetail>('/contacts', {
              method: 'POST',
              json: { ...values, organisationId: target.organisationId },
            });
            await refresh();
            onClose();
          }}
          onCancel={onClose}
        />
      </Card>
    );
  }

  const person = opened.data;
  const final = Boolean(person?.anonymisedAt || person?.archivedAt);
  return (
    <Card className="p-4">
      {opened.isLoading && <p className="text-sm text-slate-500">Loading…</p>}
      {opened.error && <Alert>{opened.error.message}</Alert>}
      {notice && (
        <p role="status" className="mb-2 text-sm text-slate-600">
          {notice}
        </p>
      )}
      {person && (
        <>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">
              {person.firstName} {person.lastName}
              <span className="ml-2 font-normal text-slate-500">· {person.organisation.displayName}</span>
              {person.anonymisedAt && <span className="ml-2 text-xs text-red-700">(anonymised)</span>}
              {!person.anonymisedAt && person.archivedAt && (
                <span className="ml-2 text-xs text-slate-500">(archived)</span>
              )}
            </h3>
            <span className="flex gap-1">
              {can.archive && !final && (
                <Button
                  variant="ghost"
                  className="h-8 px-2"
                  onClick={() => void runAction(person, 'archive')}
                >
                  Archive
                </Button>
              )}
              {can.anonymise && !person.anonymisedAt && (
                <Button
                  variant="ghost"
                  className="h-8 px-2 text-red-700"
                  onClick={() => void runAction(person, 'anonymise')}
                >
                  Anonymise (GDPR)
                </Button>
              )}
            </span>
          </div>
          <ContactForm
            key={`${person.id}:${person.version}`}
            initial={person}
            readOnly={final || !can.update}
            submitLabel="Save contact"
            onSubmit={async (values) => {
              await change(person, '', values);
              setNotice('Contact saved.');
            }}
            onCancel={onClose}
          />
        </>
      )}
    </Card>
  );
}
