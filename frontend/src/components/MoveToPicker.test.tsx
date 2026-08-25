import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MoveToPicker, type MoveToPickerCandidate } from './MoveToPicker';

const CANDIDATES: MoveToPickerCandidate[] = [
  { localId: 'e1', type: 'Epic', title: 'Bus Interfaces', customerId: '§4.7' },
  { localId: 'e2', type: 'Epic', title: 'Power Distribution', customerId: '§3.4' },
  { localId: 'f1', type: 'Feature', title: 'Inrush Current Limit', customerId: null },
];

async function openPicker(): Promise<void> {
  await userEvent.click(screen.getByRole('button', { name: /move/i }));
}

// A matched candidate's title/clause splits its text across a <mark> and
// surrounding text nodes (the highlight) -- testing-library's getByText
// matches individual text nodes by default, not aggregated content, so an
// exact-string query against a highlighted row's full title never matches.
// Matches on the containing element's full textContent instead.
function findByFullText(text: string): HTMLElement {
  return screen.getByText((_, element) => element?.textContent === text && element.children.length <= 1);
}
function queryByFullText(text: string): HTMLElement | null {
  return screen.queryByText((_, element) => element?.textContent === text && element.children.length <= 1);
}

describe('MoveToPicker', () => {
  it('lists every candidate when the search is empty', async () => {
    render(<MoveToPicker triggerLabel="Move to…" candidates={CANDIDATES} onSelect={vi.fn()} />);
    await openPicker();

    expect(findByFullText('Bus Interfaces')).toBeInTheDocument();
    expect(findByFullText('Power Distribution')).toBeInTheDocument();
    expect(findByFullText('Inrush Current Limit')).toBeInTheDocument();
  });

  it('filters by title', async () => {
    render(<MoveToPicker triggerLabel="Move to…" candidates={CANDIDATES} onSelect={vi.fn()} />);
    await openPicker();

    await userEvent.type(screen.getByPlaceholderText(/filter/i), 'inrush');

    expect(findByFullText('Inrush Current Limit')).toBeInTheDocument();
    expect(queryByFullText('Bus Interfaces')).not.toBeInTheDocument();
    expect(queryByFullText('Power Distribution')).not.toBeInTheDocument();
  });

  it('filters by customer ID', async () => {
    render(<MoveToPicker triggerLabel="Move to…" candidates={CANDIDATES} onSelect={vi.fn()} />);
    await openPicker();

    await userEvent.type(screen.getByPlaceholderText(/filter/i), '§3.4');

    expect(findByFullText('Power Distribution')).toBeInTheDocument();
    expect(queryByFullText('Bus Interfaces')).not.toBeInTheDocument();
    expect(queryByFullText('Inrush Current Limit')).not.toBeInTheDocument();
  });

  it('shows a "nothing matches" message when the filter has no hits', async () => {
    render(<MoveToPicker triggerLabel="Move to…" candidates={CANDIDATES} onSelect={vi.fn()} />);
    await openPicker();

    await userEvent.type(screen.getByPlaceholderText(/filter/i), 'zzz-does-not-exist');

    expect(screen.getByText(/nothing matches/i)).toBeInTheDocument();
  });

  it('calls onSelect with the candidate localId when a row is clicked, and closes the popover', async () => {
    const onSelect = vi.fn();
    render(<MoveToPicker triggerLabel="Move to…" candidates={CANDIDATES} onSelect={onSelect} />);
    await openPicker();

    await userEvent.click(findByFullText('Inrush Current Limit'));

    expect(onSelect).toHaveBeenCalledWith('f1');
    expect(queryByFullText('Bus Interfaces')).not.toBeInTheDocument(); // popover closed
  });

  it('does not offer "Top level" when allowRoot is false/omitted', async () => {
    render(<MoveToPicker triggerLabel="Move to…" candidates={CANDIDATES} onSelect={vi.fn()} />);
    await openPicker();

    expect(screen.queryByText(/top level/i)).not.toBeInTheDocument();
  });

  it('offers "Top level" and calls onSelect(null) when allowRoot is true', async () => {
    const onSelect = vi.fn();
    render(<MoveToPicker triggerLabel="Move to…" candidates={CANDIDATES} allowRoot onSelect={onSelect} />);
    await openPicker();

    await userEvent.click(screen.getByText(/top level/i));

    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it('shows the empty-state text when there are no candidates at all', async () => {
    render(<MoveToPicker triggerLabel="Move to…" candidates={[]} emptyText="No valid parent found here." onSelect={vi.fn()} />);
    await openPicker();

    expect(screen.getByText('No valid parent found here.')).toBeInTheDocument();
  });
});
