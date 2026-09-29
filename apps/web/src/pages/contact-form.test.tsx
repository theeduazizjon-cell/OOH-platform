import type { ContactDetail } from '@ooh/contracts';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ContactForm, parseTags } from './contact-form';

const existing: ContactDetail = {
  id: 'c1',
  organisation: { id: 'o1', displayName: 'Carrefour' },
  firstName: 'Ioana',
  lastName: 'Popescu',
  position: 'Director',
  email: 'ioana@carrefour.ro',
  phone: null,
  isPrimary: true,
  isDecisionMaker: false,
  consentStatus: 'OPTED_IN',
  newsletterEligible: true,
  tags: ['retail', 'vip'],
  archivedAt: null,
  anonymisedAt: null,
  version: 3,
  linkedin: null,
  consentSource: 'Trade fair',
  consentAt: '2026-09-01T10:00:00Z',
  unsubscribedAt: null,
  createdAt: '2026-09-01T10:00:00Z',
  updatedAt: '2026-09-01T10:00:00Z',
};

describe('ContactForm', () => {
  it('submits the details, flags and de-duplicated tags', async () => {
    const onSubmit = vi.fn(() => Promise.resolve());
    render(<ContactForm submitLabel="Add contact" onSubmit={onSubmit} onCancel={vi.fn()} />);
    await userEvent.type(screen.getByLabelText('First name'), ' Mihai ');
    await userEvent.type(screen.getByLabelText('Email'), 'mihai@x.ro');
    await userEvent.type(screen.getByLabelText('Tags (comma-separated)'), 'vip, retail,vip, ');
    await userEvent.click(screen.getByLabelText('Decision maker'));
    await userEvent.click(screen.getByRole('button', { name: 'Add contact' }));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        firstName: 'Mihai',
        lastName: null,
        email: 'mihai@x.ro',
        tags: ['vip', 'retail'],
        isPrimary: false,
        isDecisionMaker: true,
        consentStatus: 'UNKNOWN',
        consentSource: null,
      }),
    );
  });

  it('asks where a stated marketing preference was given', async () => {
    const onSubmit = vi.fn(() => Promise.resolve());
    render(<ContactForm submitLabel="Add contact" onSubmit={onSubmit} onCancel={vi.fn()} />);
    await userEvent.type(screen.getByLabelText('First name'), 'Ana');
    await userEvent.selectOptions(screen.getByLabelText('Marketing consent'), 'OPTED_IN');
    await userEvent.click(screen.getByRole('button', { name: 'Add contact' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Say where');
    expect(onSubmit).not.toHaveBeenCalled();

    await userEvent.type(screen.getByLabelText('Where was it given?'), 'Event form');
    await userEvent.click(screen.getByRole('button', { name: 'Add contact' }));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ consentStatus: 'OPTED_IN', consentSource: 'Event form' }),
    );
  });

  it('starts from an existing contact, and is read-only when final', () => {
    render(
      <ContactForm initial={existing} readOnly submitLabel="Save" onSubmit={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(screen.getByLabelText('First name')).toHaveValue('Ioana');
    expect(screen.getByLabelText('Tags (comma-separated)')).toHaveValue('retail, vip');
    expect(screen.getByLabelText('Where was it given?')).toHaveValue('Trade fair');
    expect(screen.getByLabelText('First name')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });

  it('parses tags', () => {
    expect(parseTags(' a, b,,a ,c ')).toEqual(['a', 'b', 'c']);
    expect(parseTags('')).toEqual([]);
  });
});
