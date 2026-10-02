import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { moveInOrder, NameList, parseProbability, StageEditor } from './nomenclatures-page';

describe('nomenclature helpers', () => {
  it('moves one stage up or down, never past the ends', () => {
    expect(moveInOrder(['a', 'b', 'c'], 1, -1)).toEqual(['b', 'a', 'c']);
    expect(moveInOrder(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'c', 'b']);
    expect(moveInOrder(['a', 'b', 'c'], 0, -1)).toEqual(['a', 'b', 'c']);
    expect(moveInOrder(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'b', 'c']);
  });

  it('parses a stage probability', () => {
    expect(parseProbability('')).toBeNull();
    expect(parseProbability(' 40 ')).toBe(40);
    expect(parseProbability('101')).toBeUndefined();
    expect(parseProbability('4.5')).toBeUndefined();
  });
});

describe('StageEditor', () => {
  it('validates, then saves the name and probability', async () => {
    const onSave = vi.fn(() => Promise.resolve());
    render(<StageEditor onSave={onSave} onCancel={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Add stage' }));
    expect(screen.getByText('Give the stage a name.')).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Stage name'), ' Site visit ');
    await userEvent.type(screen.getByLabelText('Probability (%)'), '150');
    await userEvent.click(screen.getByRole('button', { name: 'Add stage' }));
    expect(onSave).not.toHaveBeenCalled();

    await userEvent.clear(screen.getByLabelText('Probability (%)'));
    await userEvent.type(screen.getByLabelText('Probability (%)'), '60');
    await userEvent.click(screen.getByRole('button', { name: 'Add stage' }));
    expect(onSave).toHaveBeenCalledWith({ name: 'Site visit', probability: 60 });
  });
});

describe('NameList', () => {
  const items = [
    { id: '1', name: 'Call', active: true, version: 2 },
    { id: '2', name: 'Fax', active: false, version: 1 },
    { id: '3', name: 'Stage change', active: true, version: 1, isSystem: true },
  ];

  it('renames, disables and enables; platform entries have no actions', async () => {
    const onUpdate = vi.fn(() => Promise.resolve());
    render(
      <NameList
        title="Activity types"
        hint="h"
        addLabel="Add type"
        items={items}
        canManage
        onCreate={vi.fn()}
        onUpdate={onUpdate}
      />,
    );
    const rows = screen.getAllByRole('listitem');
    expect(within(rows[2]!).queryByRole('button')).not.toBeInTheDocument();
    expect(within(rows[2]!).getByText('platform')).toBeInTheDocument();

    await userEvent.click(within(rows[1]!).getByRole('button', { name: 'Enable' }));
    expect(onUpdate).toHaveBeenLastCalledWith(items[1], { active: true });

    await userEvent.click(within(rows[0]!).getByRole('button', { name: 'Rename' }));
    const name = screen.getByLabelText('Name');
    await userEvent.clear(name);
    await userEvent.type(name, 'Phone call');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onUpdate).toHaveBeenLastCalledWith(items[0], { name: 'Phone call' });
  });

  it('shows the API error, and is read-only without config.manage', async () => {
    const onCreate = vi.fn(() => Promise.reject(new Error('x')));
    const { rerender } = render(
      <NameList
        title="T"
        hint="h"
        addLabel="Add type"
        items={items}
        canManage
        onCreate={onCreate}
        onUpdate={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Add type' }));
    await userEvent.type(screen.getByLabelText('Name'), 'Visit');
    await userEvent.click(screen.getAllByRole('button', { name: 'Add type' }).at(-1)!);
    expect(onCreate).toHaveBeenCalledWith('Visit');
    expect(screen.getByText('Could not reach the server. Try again.')).toBeInTheDocument();

    rerender(
      <NameList
        title="T"
        hint="h"
        addLabel="Add type"
        items={items}
        canManage={false}
        onCreate={vi.fn()}
        onUpdate={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Rename' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add type' })).not.toBeInTheDocument();
  });
});
