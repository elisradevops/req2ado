import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { RulebookDetails, RulebookView } from '../api/jobs';
import { FileRulesCard, applyEdits, reasonPhrase } from './FileRulesCard';

const rulebook = {
  version: 1,
  hash: 'abcdef1234567890',
  tables: { t0: { nesting: 'order', type_map: { אפיק: 'Epic', "פיצ'ר": 'Feature', דרישה: 'Requirement', באג: null } } },
  document: { labels: [{ label: 'יכולת', separator: ':', type: 'Feature' }], depth_types: [] },
};
const view = (over: Partial<RulebookView> = {}): RulebookView => ({
  id: 'rb1',
  source: 'model',
  hash: 'abcdef1234567890',
  rules: ["Sheet: Types are stated in column 'סוג פריט' (1 Epic, 6 Features, 31 Requirements); nesting from row order. (read by the model)"],
  warnings: [],
  rulebook,
  reused: false,
  ...over,
});
const props = (over: Partial<React.ComponentProps<typeof FileRulesCard>> = {}) => ({
  status: 'ready' as const,
  view: view(),
  error: null,
  onRelearn: vi.fn(),
  onSaveEdit: vi.fn().mockResolvedValue(null),
  ...over,
});

describe('FileRulesCard', () => {
  it('says it runs for every file, and waits for the file before it starts', () => {
    render(<FileRulesCard {...props({ status: 'idle', view: null })} />);
    expect(screen.getByText(/this runs for every file, in both modes/i)).toBeInTheDocument();
    expect(screen.getByText(/waiting for the file to be read/i)).toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  });

  it('says plainly that it was skipped without a model connection, and offers nothing to edit', () => {
    const skipped = view({ id: null, source: 'none', rules: [], hash: '', skipped: 'No model connection is configured for your account, so the file is read by its recognised headings and its shape.' });
    render(<FileRulesCard {...props({ view: skipped })} />);
    expect(screen.getByTestId('file-rules-skipped')).toHaveTextContent(/no model connection is configured/i);
    expect(screen.queryByRole('button', { name: /edit types/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/nothing the model could verify/i)).not.toBeInTheDocument();
  });

  it('shows progress while the model reads, and says the job starts once it is read', () => {
    render(<FileRulesCard {...props({ status: 'loading', view: null })} />);
    expect(screen.getByRole('status')).toHaveTextContent(/reading the file's conventions/i);
    expect(screen.getByRole('status')).toHaveTextContent(/the job can start once it is read/i);
  });

  it('shows how long the reading has run, outside the status message, with no "Stop waiting" (Start waits for the study)', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-20T10:00:00Z') });
    try {
      render(<FileRulesCard {...props({ status: 'loading', view: null, startedAt: '2026-11-20T10:00:00Z' })} />);
      expect(screen.getByTestId('file-rules-elapsed')).toHaveTextContent('00:00 so far');
      await act(async () => {
        vi.advanceTimersByTime(12_000);
      });
      expect(screen.getByTestId('file-rules-elapsed')).toHaveTextContent('00:12 so far');
      expect(screen.getByRole('status')).not.toHaveTextContent('00:12');
      expect(screen.getByRole('status')).not.toHaveTextContent(/typical/i);
      expect(screen.queryByRole('button', { name: 'Stop waiting' })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('says when the job will use another model than the one that read the file, and offers to read again with it', async () => {
    const onRelearn = vi.fn();
    const { rerender } = render(<FileRulesCard {...props({ modelHint: { readWith: 'the default model', jobUses: 'gpt-4o' }, onRelearn })} />);
    expect(screen.getByTestId('file-rules-model-hint')).toHaveTextContent('Read with the default model. This job will use gpt-4o.');
    await userEvent.click(screen.getByRole('button', { name: 'Read again with gpt-4o' }));
    expect(onRelearn).toHaveBeenCalledTimes(1);
    rerender(<FileRulesCard {...props({ modelHint: null })} />);
    expect(screen.queryByTestId('file-rules-model-hint')).not.toBeInTheDocument();
  });

  it('names the model that reads the file, but not before it is asked or when the reading was skipped', () => {
    const { rerender } = render(<FileRulesCard {...props({ status: 'loading', view: null, modelLabel: 'Default' })} />);
    expect(screen.getByText('Model: Default')).toBeInTheDocument();
    rerender(<FileRulesCard {...props({ modelLabel: 'gpt-4o' })} />);
    expect(screen.getByText('Model: gpt-4o')).toBeInTheDocument();
    rerender(<FileRulesCard {...props({ status: 'idle', view: null, modelLabel: 'Default' })} />);
    expect(screen.queryByText(/^Model:/)).not.toBeInTheDocument();
    rerender(<FileRulesCard {...props({ view: view({ id: null, source: 'none', rules: [], hash: '', skipped: 'No model connection.' }), modelLabel: 'Default' })} />);
    expect(screen.queryByText(/^Model:/)).not.toBeInTheDocument();
  });

  it('shows what was learned in words, where it came from, and a short hash that makes the same file recognisable', () => {
    render(<FileRulesCard {...props({ view: view({ reused: true }) })} />);
    expect(screen.getByText(/read by the model, checked against every row · reused from an earlier upload/i)).toBeInTheDocument();
    expect(screen.getByText(/types are stated in column 'סוג פריט'/i)).toBeInTheDocument();
    expect(screen.getByText('rules abcdef12')).toBeInTheDocument();
  });

  it('says plainly when nothing could be verified, with the reason, and that the file is read the usual way', () => {
    const none = view({ id: null, source: 'none', rules: [], warnings: [{ kind: 'prestudy_rejected', raw: "The model's reading of how the document was not used: too few rows." }] });
    render(<FileRulesCard {...props({ view: none })} />);
    expect(screen.getByText(/nothing the model could verify/i)).toBeInTheDocument();
    expect(screen.getByText(/too few rows/i)).toBeInTheDocument();
    expect(screen.getByText(/read by its recognised headings and its shape/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /edit types/i })).not.toBeInTheDocument(); // nothing stored, nothing to edit
  });

  it('offers to try again after a failure', async () => {
    const onRelearn = vi.fn();
    render(<FileRulesCard {...props({ status: 'error', view: null, error: 'The model timed out.', onRelearn })} />);
    expect(screen.getByText(/the model timed out\./i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(onRelearn).toHaveBeenCalled();
  });

  it('reads again on request', async () => {
    const onRelearn = vi.fn();
    render(<FileRulesCard {...props({ onRelearn })} />);
    await userEvent.click(screen.getByRole('button', { name: /read again/i }));
    expect(onRelearn).toHaveBeenCalled();
  });

  it('lets a type mapping be corrected and sends the edited rulebook, leaving everything else as it was', async () => {
    const onSaveEdit = vi.fn().mockResolvedValue(null);
    render(<FileRulesCard {...props({ onSaveEdit })} />);
    await userEvent.click(screen.getByRole('button', { name: /edit types/i }));
    await userEvent.click(screen.getByRole('combobox', { name: /type for rows typed באג/i }));
    await userEvent.click(await screen.findByRole('option', { name: 'Requirement' }));
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(onSaveEdit).toHaveBeenCalledTimes(1));
    const sent = onSaveEdit.mock.calls[0][0] as typeof rulebook;
    expect(sent.tables.t0.type_map).toEqual({ אפיק: 'Epic', "פיצ'ר": 'Feature', דרישה: 'Requirement', באג: 'Requirement' });
    expect(sent.tables.t0.nesting).toBe('order');
  });

  it('keeps the edit open and shows the file\'s reason when the edit does not fit', async () => {
    const onSaveEdit = vi.fn().mockResolvedValue('the rules for the sheet do not fit it: too many rows nest in a way the ladder does not allow');
    render(<FileRulesCard {...props({ onSaveEdit })} />);
    await userEvent.click(screen.getByRole('button', { name: /edit types/i }));
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));
    expect(await screen.findByText(/do not fit it: too many rows nest/i)).toBeInTheDocument();
    expect(screen.getByTestId('file-rules-edit')).toBeInTheDocument();
  });
});

const skippedRows = Array.from({ length: 20 }, (_, i) => ({ row: 13 + i, reason: 'type:באג', text: `בדיקת מערכת ${i + 1}` }));
const details = (over: Partial<RulebookDetails['tables'][number]> = {}): RulebookDetails => ({
  approximate: false,
  tables: [
    {
      name: 'Sheet',
      totalRows: 346,
      typeCounts: { Epic: 4, Feature: 39, Requirement: 235 },
      samples: {
        Epic: [{ row: 2, title: 'Customer Software Requirements', parent: null }],
        Feature: [{ row: 3, title: 'ICC Station', parent: 'Customer Software Requirements' }],
        Requirement: [{ row: 4, title: 'ICC SW – Hierarchical command model', parent: 'ICC Station' }],
      },
      skipped: { count: 68, byReason: { 'type:באג': 68 }, rows: skippedRows, more: 48 },
      ...over,
    },
  ],
  document: null,
});

describe('FileRulesCard: what the rules make of the file', () => {
  it('shows the count of each type and of the rows not imported, with the details closed', () => {
    render(<FileRulesCard {...props({ view: view({ details: details() }) })} />);
    expect(screen.getByTestId('file-rules-counts')).toHaveTextContent('Epic 4 · Feature 39 · Requirement 235 · Not imported 68 rows');
    expect(screen.getByRole('button', { name: /show examples/i })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('button', { name: /rows not imported \(68\)/i })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('ICC Station')).not.toBeInTheDocument();
  });

  it('shows a few items of each type with their row in the file and their parent', async () => {
    render(<FileRulesCard {...props({ view: view({ details: details() }) })} />);
    await userEvent.click(screen.getByRole('button', { name: /show examples/i }));
    const region = screen.getByRole('region', { name: /show examples/i });
    expect(region).toHaveTextContent('row 2Customer Software Requirements');
    expect(region).toHaveTextContent('row 3ICC Station↳ under Customer Software Requirements');
    expect(screen.getByText('↳ under ICC Station')).toHaveAttribute('dir', 'auto');
    expect(region.textContent!.match(/↳ under/g)).toHaveLength(2); // the Epic is a root: no parent line
  });

  it('lists the rows not imported, grouped by reason first, with the file\'s own text untouched and how many more there are', async () => {
    render(<FileRulesCard {...props({ view: view({ details: details() }) })} />);
    await userEvent.click(screen.getByRole('button', { name: /rows not imported/i }));
    const region = screen.getByRole('region', { name: /rows not imported/i });
    expect(region).toHaveTextContent('68 rows: type “באג” is not an Epic, Feature or Requirement');
    expect(screen.getByText('בדיקת מערכת 1')).toHaveAttribute('dir', 'auto');
    expect(region).toHaveTextContent('row 13');
    expect(region).toHaveTextContent('+48 more');
  });

  it('says why in words for every reason a row is not imported', () => {
    expect(reasonPhrase('under_skipped')).toBe('sits under a row that is not imported');
    expect(reasonPhrase('no_title')).toBe('has no title');
    expect(reasonPhrase('no_type')).toBe('states no type');
    expect(reasonPhrase('in_cycle')).toBe('its parents form a cycle');
  });

  it('shows no not-imported list when every row is imported', () => {
    render(<FileRulesCard {...props({ view: view({ details: details({ skipped: { count: 0, byReason: {}, rows: [], more: 0 } }) }) })} />);
    expect(screen.getByTestId('file-rules-counts')).toHaveTextContent(/^Epic 4 · Feature 39 · Requirement 235$/);
    expect(screen.queryByRole('button', { name: /rows not imported/i })).not.toBeInTheDocument();
  });

  it('gives a document\'s counts as an estimate and lists nothing as not imported', () => {
    const document = { typeCounts: { Epic: 0, Feature: 12, Requirement: 40 }, samples: { Feature: [{ row: null, title: 'יכולת: הספק', parent: null }] }, approximate: true as const };
    render(<FileRulesCard {...props({ view: view({ details: { approximate: true, tables: [], document } }) })} />);
    expect(screen.getByTestId('file-rules-counts')).toHaveTextContent(/^about 12 Features, about 40 Requirements/);
    expect(screen.queryByRole('button', { name: /rows not imported/i })).not.toBeInTheDocument();
  });

  it('asks to read again for a rulebook stored before the breakdown was kept, and says nothing extra when nothing was learned or the study was skipped', () => {
    const { rerender } = render(<FileRulesCard {...props({ view: view({ details: null }) })} />);
    expect(screen.getByTestId('file-rules-no-breakdown')).toHaveTextContent('Read again to see the breakdown.');
    rerender(<FileRulesCard {...props({ view: view({ id: null, source: 'none', rules: [] }) })} />);
    expect(screen.queryByTestId('file-rules-no-breakdown')).not.toBeInTheDocument();
    rerender(<FileRulesCard {...props({ view: view({ id: null, source: 'none', rules: [], hash: '', skipped: 'No model connection.' }) })} />);
    expect(screen.queryByTestId('file-rules-no-breakdown')).not.toBeInTheDocument();
    expect(screen.queryByTestId('file-rules-breakdown')).not.toBeInTheDocument();
  });

  it('shows the new counts once an edit is saved', () => {
    const { rerender } = render(<FileRulesCard {...props({ view: view({ details: details() }) })} />);
    const edited = details({ typeCounts: { Epic: 4, Feature: 39, Requirement: 303 }, skipped: { count: 0, byReason: {}, rows: [], more: 0 } });
    rerender(<FileRulesCard {...props({ view: view({ source: 'user', details: edited }) })} />);
    expect(screen.getByTestId('file-rules-counts')).toHaveTextContent('Requirement 303');
    expect(screen.getByTestId('file-rules-counts')).not.toHaveTextContent(/not imported/i);
  });
});

describe('applyEdits', () => {
  it('turns "Not imported" into null, changes only what was chosen, and does not touch the original', () => {
    const edited = applyEdits(rulebook, { types: { t0: { דרישה: 'Not imported', באג: 'Feature' } }, labels: { 0: 'Requirement' } }) as typeof rulebook;
    expect(edited.tables.t0.type_map).toEqual({ אפיק: 'Epic', "פיצ'ר": 'Feature', דרישה: null, באג: 'Feature' });
    expect(edited.document.labels[0].type).toBe('Requirement');
    expect(rulebook.tables.t0.type_map.דרישה).toBe('Requirement');
    expect(rulebook.document.labels[0].type).toBe('Feature');
  });
});
