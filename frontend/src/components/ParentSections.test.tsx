import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ItsDecision, UnderIt, decisionFor } from './ParentSections';
import type { DryRunDiffEntry } from './DiffTree';
import type { ReadingDecision } from '../api/jobs';

const item = (localId: string, parentLocalId: string | null, type: string, title: string, extra: Partial<DryRunDiffEntry> = {}): DryRunDiffEntry => ({
  localId, parentLocalId, type, title, description: '', action: 'create', customerId: null, tags: [], ...extra,
});

const rename: ReadingDecision = { headingId: 'b4', action: 'rename', title: 'General', newTitle: 'Power', reason: 'Its sections are all about power.', decision: 'accept' };
const drop: ReadingDecision = { headingId: 'b9', action: 'drop_wrapper', title: 'Requirements', newTitle: null, reason: 'A level that only groups.', decision: null };

describe('decisionFor', () => {
  it('finds the decision for the heading an item was built from, and none for other items', () => {
    expect(decisionFor(item('g_b4', null, 'Epic', 'Power'), [rename, drop])).toBe(rename);
    expect(decisionFor(item('g_epic', null, 'Epic', 'Doc'), [rename, drop])).toBeUndefined();
  });
});

describe('ItsDecision', () => {
  it('switches a rename by its title: Keep puts the file\'s title back, Accept the proposed one', async () => {
    const onRename = vi.fn();
    const { rerender } = render(<ItsDecision entry={item('g_b4', null, 'Epic', 'Power')} decision={rename} editable onRename={onRename} />);
    expect(screen.getByRole('button', { name: 'Accept' })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(screen.getByRole('button', { name: 'Keep' }));
    expect(onRename).toHaveBeenCalledWith('General');
    rerender(<ItsDecision entry={item('g_b4', null, 'Epic', 'General')} decision={rename} editable onRename={onRename} />);
    expect(screen.getByRole('button', { name: 'Keep' })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(screen.getByRole('button', { name: 'Accept' }));
    expect(onRename).toHaveBeenLastCalledWith('Power');
  });

  it('shows a kept level removal with its reason and how to change it, with no switch', () => {
    render(<ItsDecision entry={item('g_b9', null, 'Epic', 'Requirements')} decision={drop} editable onRename={vi.fn()} />);
    const section = screen.getByTestId('its-decision');
    expect(section).toHaveTextContent('Proposed: remove this level');
    expect(section).toHaveTextContent('A level that only groups.');
    expect(section).toHaveTextContent('Kept as the file has it. To change it, start a new job from this file.');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows a written item\'s rename as decided, without the switch', () => {
    render(<ItsDecision entry={item('g_b4', null, 'Epic', 'Power')} decision={rename} editable={false} onRename={vi.fn()} />);
    expect(screen.getByTestId('its-decision')).toHaveTextContent('Accepted.');
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('UnderIt', () => {
  const entries = [
    item('e', null, 'Epic', 'Power'),
    item('f1', 'e', 'Feature', 'Supply'),
    item('r1', 'f1', 'Requirement', 'Accept mains'),
    item('r2', 'f1', 'Requirement', 'Fuse', { excluded: true }),
    item('f2', 'e', 'Feature', 'Standby', { excluded: true }),
    item('r3', 'f2', 'Requirement', 'Standby draw'),
  ];

  it('counts what will be written (left-out items and their subtrees excluded) and marks left-out children', () => {
    render(<UnderIt entry={entries[0]} entries={entries} onOpen={vi.fn()} />);
    const section = screen.getByTestId('under-it');
    expect(section).toHaveTextContent('1 Feature · 1 requirement will be written');
    expect(screen.getByRole('button', { name: /Standby/ })).toHaveTextContent('Left out');
    expect(screen.getByRole('button', { name: /Supply/ })).toHaveTextContent('2');
  });

  it('opens a child on click', async () => {
    const onOpen = vi.fn();
    render(<UnderIt entry={entries[0]} entries={entries} onOpen={onOpen} />);
    await userEvent.click(screen.getByRole('button', { name: /Supply/ }));
    expect(onOpen).toHaveBeenCalledWith('f1');
  });

  it('says so when nothing is under it', () => {
    render(<UnderIt entry={item('lonely', null, 'Feature', 'Lonely')} entries={[]} />);
    expect(screen.getByText('Nothing is under this Feature yet.')).toBeInTheDocument();
  });
});
