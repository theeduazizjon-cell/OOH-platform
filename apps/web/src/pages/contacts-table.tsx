import type { ContactListItem } from '@ooh/contracts';
import { CONSENT_LABELS } from './contact-form';

/** Contacts as a table; `showCompany` for lists spanning several companies. */
export function ContactsTable({
  contacts,
  showCompany,
  onOpen,
  emptyText,
}: {
  contacts: readonly ContactListItem[];
  showCompany: boolean;
  onOpen: (id: string) => void;
  emptyText: string;
}) {
  return (
    <table className="w-full text-left text-sm">
      <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase text-slate-500">
        <tr>
          <th className="px-3 py-2">Name</th>
          {showCompany && <th className="px-3 py-2">Company</th>}
          <th className="px-3 py-2">Position</th>
          <th className="px-3 py-2">Email</th>
          <th className="px-3 py-2">Phone</th>
          <th className="px-3 py-2">Marketing</th>
        </tr>
      </thead>
      <tbody>
        {contacts.length === 0 && (
          <tr>
            <td colSpan={showCompany ? 6 : 5} className="px-3 py-4 text-center text-slate-500">
              {emptyText}
            </td>
          </tr>
        )}
        {contacts.map((c) => (
          <tr key={c.id} className="border-b border-slate-100 last:border-0">
            <td className="px-3 py-2">
              <button
                type="button"
                className="font-medium text-brand-700 hover:underline"
                onClick={() => onOpen(c.id)}
              >
                {c.firstName} {c.lastName}
              </button>
              {c.isPrimary && (
                <span className="ml-2 rounded bg-brand-50 px-1.5 py-0.5 text-xs text-brand-700">Primary</span>
              )}
              {c.isDecisionMaker && (
                <span className="ml-1 rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-700">
                  Decision maker
                </span>
              )}
            </td>
            {showCompany && <td className="px-3 py-2">{c.organisation.displayName}</td>}
            <td className="px-3 py-2">{c.position}</td>
            <td className="px-3 py-2">{c.email}</td>
            <td className="px-3 py-2">{c.phone}</td>
            <td className="px-3 py-2">{CONSENT_LABELS[c.consentStatus]}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
