import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { CollapsibleWarnings } from './CollapsibleWarnings';
import type { WarningRecord } from '../utils/warnings';

function warning(overrides: Partial<WarningRecord> & Pick<WarningRecord, 'kind' | 'severity' | 'raw'>): WarningRecord {
  return { nodeIds: [], detail: {}, ...overrides };
}

function ids(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `n${i}`);
}

function renderWarnings(
  warnings: WarningRecord[],
  opts?: {
    onFocusKind?: (kind: string, nodeIds: string[], label: string) => void;
    focusedKind?: string | null;
    reviewedIds?: ReadonlySet<string>;
    onAcknowledge?: (kind: string, raws: string[] | undefined, acknowledged: boolean) => void;
    onRetryEnhancement?: (kind: string, batches: { pass: 'title_tag' | 'synthesis'; localIds: string[] }[]) => void;
    onCancelRetry?: () => void;
    retryProgress?: { kind: string; done: number; total: number } | null;
    onJumpToNode?: (localId: string) => void;
    adoIdByLocalId?: Record<string, number>;
    titleByLocalId?: Record<string, string>;
    orgUrl?: string | null;
    project?: string | null;
  },
) {
  return render(
    <MemoryRouter>
      <CollapsibleWarnings
        warnings={warnings}
        onFocusKind={opts?.onFocusKind}
        focusedKind={opts?.focusedKind}
        reviewedIds={opts?.reviewedIds}
        onAcknowledge={opts?.onAcknowledge}
        onRetryEnhancement={opts?.onRetryEnhancement}
        onCancelRetry={opts?.onCancelRetry}
        retryProgress={opts?.retryProgress}
        onJumpToNode={opts?.onJumpToNode}
        adoIdByLocalId={opts?.adoIdByLocalId}
        titleByLocalId={opts?.titleByLocalId}
        orgUrl={opts?.orgUrl}
        project={opts?.project}
      />
    </MemoryRouter>,
  );
}

describe('CollapsibleWarnings', () => {
  it('renders nothing when there are no warnings', () => {
    const { container } = renderWarnings([]);
    expect(container.firstChild).toBeNull();
  });

  it('groups by what the reviewer has to do, not by ingestion severity', async () => {
    renderWarnings([
      warning({ kind: 'missing_source_reference', severity: 'needs_review', raw: '14 requirements have no source reference.' }),
      warning({ kind: 'low_grounding', severity: 'needs_review', raw: '80 nodes have low grounding.' }),
      // A pipeline FAILURE that leaves the output complete is informational.
      warning({ kind: 'enhancement_call_failed', severity: 'pipeline_issue', raw: 'Enhancement failed.' }),
    ]);

    expect(screen.getByText('Fix before confirming (1)')).toBeInTheDocument();
    expect(screen.getByText('Review (1)')).toBeInTheDocument();
    expect(screen.getByText('For your information (1)')).toBeInTheDocument();
    expect(screen.getByText('1 to fix, 1 to review, 1 for your information')).toBeInTheDocument();
    // Rows for fix and review are visible; the info row is behind its group header.
    expect(screen.getByText('Requirement has no Customer ID')).toBeInTheDocument();
    expect(screen.getByText('Low grounding: possible fabrication')).toBeInTheDocument();
    expect(screen.queryByText('Enhanced wording unavailable')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /for your information/i }));
    expect(screen.getByText('Enhanced wording unavailable')).toBeInTheDocument();
  });

  it('opens the informational group by default when it is the only group', () => {
    renderWarnings([
      warning({ kind: 'reparented_to_feature', severity: 'auto_fixed', raw: '3 Requirement(s) were re-parented under Feature f0.' }),
    ]);
    expect(screen.getByText('Re-parented under a Feature')).toBeInTheDocument();
  });

  it('shows one row with a single tree button for a kind covering hundreds of items, never one button per item', async () => {
    // The reported case: "The text synthesis enhancement call failed for 275
    // item(s) across 2 chunk(s)" used to render 275 "Review ..." buttons.
    const onFocusKind = vi.fn();
    const nodeIds = ids(275);
    renderWarnings(
      [
        warning({ kind: 'enhancement_call_failed', severity: 'pipeline_issue', raw: 'The text synthesis enhancement call failed for 275 item(s).', nodeIds }),
        warning({ kind: 'low_grounding', severity: 'needs_review', raw: 'Some node has low grounding.' }),
      ],
      { onFocusKind, onJumpToNode: vi.fn() },
    );
    await userEvent.click(screen.getByRole('button', { name: /for your information/i }));

    expect(screen.getByText('275 items')).toBeInTheDocument();
    await userEvent.click(screen.getByText('Enhanced wording unavailable'));
    expect(screen.queryAllByRole('button', { name: /^open /i })).toHaveLength(0);

    await userEvent.click(screen.getByRole('button', { name: 'Show in tree' }));
    expect(onFocusKind).toHaveBeenCalledWith('enhancement_call_failed', nodeIds, 'Enhanced wording unavailable');
  });

  it('labels the tree button by what the reviewer is doing', () => {
    renderWarnings(
      [
        warning({ kind: 'missing_source_reference', severity: 'needs_review', raw: 'a', nodeIds: ids(14) }),
        warning({ kind: 'low_grounding', severity: 'needs_review', raw: 'b', nodeIds: ids(80) }),
        warning({ kind: 'near_duplicate_conflict', severity: 'needs_review', raw: 'c', nodeIds: ['n0', 'n1'] }),
      ],
      { onFocusKind: vi.fn() },
    );
    expect(screen.getByRole('button', { name: 'Fix in tree' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Review in tree' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Compare' })).toBeInTheDocument();
  });

  it('offers no tree button when the kind has no affected items or no handler is given', () => {
    const { unmount } = renderWarnings([warning({ kind: 'zero_nodes', severity: 'pipeline_issue', raw: 'Section produced 0 work items.' })], {
      onFocusKind: vi.fn(),
    });
    expect(screen.queryByRole('button', { name: /in tree|compare/i })).not.toBeInTheDocument();
    unmount();

    renderWarnings([warning({ kind: 'low_grounding', severity: 'needs_review', raw: 'x', nodeIds: ids(3) })]);
    expect(screen.queryByRole('button', { name: /in tree|compare/i })).not.toBeInTheDocument();
  });

  it('marks the focused row as pressed', () => {
    renderWarnings([warning({ kind: 'low_grounding', severity: 'needs_review', raw: 'x', nodeIds: ids(3) })], {
      onFocusKind: vi.fn(),
      focusedKind: 'low_grounding',
    });
    expect(screen.getByRole('button', { name: 'Review in tree' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('states what it means, what to do and how it was reported when a row is opened', async () => {
    renderWarnings([
      warning({ kind: 'enhancement_call_failed', severity: 'pipeline_issue', raw: 'Enhancement failed for 2 items.', nodeIds: ids(2) }),
      warning({ kind: 'low_grounding', severity: 'needs_review', raw: 'x' }),
    ]);
    await userEvent.click(screen.getByRole('button', { name: /for your information/i }));
    expect(screen.queryByText('What to do')).not.toBeInTheDocument();

    await userEvent.click(screen.getByText('Enhanced wording unavailable'));

    expect(screen.getByText('What it means')).toBeInTheDocument();
    expect(screen.getByText(/nothing is missing from the tree/i)).toBeInTheDocument();
    expect(screen.getByText('What to do')).toBeInTheDocument();
    expect(screen.getByText(/resubmit the job/i)).toBeInTheDocument();
    expect(screen.getByText('Reported as')).toBeInTheDocument();
    expect(screen.getByText('Pipeline issue')).toBeInTheDocument();
    expect(screen.getByText('Enhancement failed for 2 items.')).toBeInTheDocument();
  });

  it('shows the first three notices of a kind and the rest on request', async () => {
    renderWarnings(
      Array.from({ length: 6 }, (_, i) =>
        warning({ kind: 'dropped_blocks', severity: 'needs_review', raw: `Section ${i + 1} dropped blocks.` }),
      ),
    );
    await userEvent.click(screen.getByText('Content the model may have dropped'));

    expect(screen.getByText('Section 3 dropped blocks.')).toBeInTheDocument();
    expect(screen.queryByText('Section 4 dropped blocks.')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Show 3 more notices' }));
    expect(screen.getByText('Section 6 dropped blocks.')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Show fewer' }));
    expect(screen.queryByText('Section 6 dropped blocks.')).not.toBeInTheDocument();
  });

  it('counts a kind by unit when it carries no item ids', () => {
    renderWarnings([
      warning({ kind: 'dropped_blocks', severity: 'needs_review', raw: 'a' }),
      warning({ kind: 'dropped_blocks', severity: 'needs_review', raw: 'b' }),
    ]);
    expect(screen.getByText('2 sections')).toBeInTheDocument();
  });

  it('falls back an unrecognized kind to a humanized title, grouped by its severity', async () => {
    renderWarnings([
      warning({ kind: 'some_future_kind', severity: 'needs_review', raw: 'A brand new kind of notice.' }),
      warning({ kind: 'another_future_kind', severity: 'auto_fixed', raw: 'Handled.' }),
    ]);

    expect(screen.getByText('Some Future Kind')).toBeInTheDocument();
    expect(screen.getByText('Review (1)')).toBeInTheDocument();
    // auto_fixed fallback lands in the (collapsed) informational group.
    expect(screen.queryByText('Another Future Kind')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /for your information/i }));
    expect(screen.getByText('Another Future Kind')).toBeInTheDocument();
  });

  it('links to the knowledge base only for external-reference warnings', async () => {
    renderWarnings([
      warning({
        kind: 'external_reference',
        severity: 'needs_review',
        raw: "Section br0_ references an external artifact ('ReqID') this SURVEY run did not ingest.",
      }),
    ]);
    await userEvent.click(screen.getByText('References to documents not in your knowledge base'));

    expect(screen.getByRole('link', { name: /add to knowledge base/i })).toHaveAttribute('href', '/knowledge-base');
  });

  it('marks a legacy (reclassified) warning distinctly', async () => {
    renderWarnings([warning({ kind: 'other', severity: 'needs_review', raw: 'An old, unclassified warning.', legacy: true })]);
    await userEvent.click(screen.getByText('Other analysis notices'));

    expect(screen.getByText(/from an older run/i)).toBeInTheDocument();
  });

  describe('small item sets', () => {
    it('lists up to five affected items with their real titles and opens one on click', async () => {
      const onJumpToNode = vi.fn();
      renderWarnings(
        [
          warning({
            kind: 'near_duplicate_conflict',
            severity: 'needs_review',
            raw: "Near-duplicate items 'Power supply efficiency', 'Power supply efficiency (appendix)' state conflicting values.",
            nodeIds: ['n0', 'n1'],
          }),
        ],
        { onJumpToNode, titleByLocalId: { n0: 'Power supply efficiency', n1: 'Power supply efficiency (appendix)' } },
      );
      await userEvent.click(screen.getByText('Near-duplicates with conflicting values'));

      const open = screen.getAllByRole('button', { name: /^open "/i });
      expect(open).toHaveLength(2);
      expect(open[0]).toHaveAccessibleName('Open "Power supply efficiency"');
      expect(open[1]).toHaveAccessibleName('Open "Power supply efficiency (appendix)"');

      await userEvent.click(open[0]);
      expect(onJumpToNode).toHaveBeenCalledWith('n0');
    });

    it('falls back to an indexed label when no title is known', async () => {
      renderWarnings(
        [warning({ kind: 'near_duplicate_conflict', severity: 'needs_review', raw: 'x', nodeIds: ['n0', 'n1'] })],
        { onJumpToNode: vi.fn() },
      );
      await userEvent.click(screen.getByText('Near-duplicates with conflicting values'));

      expect(screen.getByRole('button', { name: 'Open item 1' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Open item 2' })).toBeInTheDocument();
    });

    it('links to the real Azure DevOps work item for an item that already exists there', async () => {
      renderWarnings(
        [warning({ kind: 'near_duplicate_conflict', severity: 'needs_review', raw: 'x', nodeIds: ['n0', 'n1'] })],
        { onJumpToNode: vi.fn(), adoIdByLocalId: { n1: 604 }, orgUrl: 'https://dev.azure.com/example-org' },
      );
      await userEvent.click(screen.getByText('Near-duplicates with conflicting values'));

      expect(screen.getAllByRole('button', { name: /^open /i })).toHaveLength(2);
      expect(screen.getByRole('link', { name: /view wi #604 in azure devops/i })).toHaveAttribute(
        'href',
        'https://dev.azure.com/example-org/_workitems/edit/604',
      );
    });

    it('includes the project segment in the Azure DevOps link when given', async () => {
      renderWarnings(
        [warning({ kind: 'near_duplicate_conflict', severity: 'needs_review', raw: 'x', nodeIds: ['n0'] })],
        { onJumpToNode: vi.fn(), adoIdByLocalId: { n0: 604 }, orgUrl: 'https://dev.azure.com/example-org', project: 'elisradevops-project' },
      );
      await userEvent.click(screen.getByText('Near-duplicates with conflicting values'));

      expect(screen.getByRole('link', { name: /view wi #604/i })).toHaveAttribute(
        'href',
        'https://dev.azure.com/example-org/elisradevops-project/_workitems/edit/604',
      );
    });

    it('lists no items at all once a kind covers more than five', async () => {
      renderWarnings([warning({ kind: 'low_grounding', severity: 'needs_review', raw: 'x', nodeIds: ids(6) })], {
        onJumpToNode: vi.fn(),
        onFocusKind: vi.fn(),
      });
      await userEvent.click(screen.getByText('Low grounding: possible fabrication'));

      const row = screen.getByText('Low grounding: possible fabrication').closest('[data-state]')!.parentElement!;
      expect(within(row).queryAllByRole('button', { name: /^open /i })).toHaveLength(0);
      expect(screen.getByRole('button', { name: 'Review in tree' })).toBeInTheDocument();
    });
  });

  describe('review progress', () => {
    it('shows how many of a kind\'s items are reviewed, as a progress bar and a count', () => {
      renderWarnings([warning({ kind: 'low_grounding', severity: 'needs_review', raw: 'x', nodeIds: ids(80) })], {
        reviewedIds: new Set(ids(28)),
      });

      expect(screen.getByText('28 of 80 reviewed')).toBeInTheDocument();
      expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '35');
      expect(screen.queryByText('Done')).not.toBeInTheDocument();
    });

    it('marks a kind Done, with no progress bar, once every item is reviewed', () => {
      renderWarnings([warning({ kind: 'low_grounding', severity: 'needs_review', raw: 'x', nodeIds: ids(3) })], {
        reviewedIds: new Set(ids(3)),
      });

      expect(screen.getByText('Done')).toBeInTheDocument();
      expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
      expect(screen.queryByText(/reviewed$/)).not.toBeInTheDocument();
    });

    it('never shows progress or Done for an informational kind', () => {
      renderWarnings([warning({ kind: 'enhancement_call_failed', severity: 'pipeline_issue', raw: 'x', nodeIds: ids(5) })], {
        reviewedIds: new Set(ids(5)),
      });

      expect(screen.queryByText('Done')).not.toBeInTheDocument();
      expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    });
  });

  describe('marking a kind handled', () => {
    it('offers Mark handled for a kind with no items, and acknowledges all of its records', async () => {
      const onAcknowledge = vi.fn();
      renderWarnings([warning({ kind: 'zero_nodes', severity: 'pipeline_issue', raw: 'Section produced 0 work items.' })], { onAcknowledge });

      await userEvent.click(screen.getByRole('button', { name: 'Mark handled' }));

      expect(onAcknowledge).toHaveBeenCalledWith('zero_nodes', undefined, true);
    });

    it('turns an acknowledged kind into Done with an Undo that un-acknowledges it', async () => {
      const onAcknowledge = vi.fn();
      renderWarnings([warning({ kind: 'zero_nodes', severity: 'pipeline_issue', raw: 'x', acknowledged: true })], { onAcknowledge });

      expect(screen.getByText('Done')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Mark handled' })).not.toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'Undo' }));

      expect(onAcknowledge).toHaveBeenCalledWith('zero_nodes', undefined, false);
    });

    it('offers no marking controls when no handler is given (job no longer awaiting review)', () => {
      renderWarnings([warning({ kind: 'zero_nodes', severity: 'pipeline_issue', raw: 'x' })]);

      expect(screen.queryByRole('button', { name: /mark handled|undo|fine as is/i })).not.toBeInTheDocument();
    });

    it('never offers Mark handled on an informational kind', () => {
      renderWarnings([warning({ kind: 'trace_link_inference_failed', severity: 'pipeline_issue', raw: 'x' })], { onAcknowledge: vi.fn() });

      expect(screen.queryByRole('button', { name: 'Mark handled' })).not.toBeInTheDocument();
    });

    it('lets each notice of an item-less kind be marked fine on its own, by its text', async () => {
      const onAcknowledge = vi.fn();
      renderWarnings(
        [
          warning({ kind: 'dropped_blocks', severity: 'needs_review', raw: 'Section 1 dropped.' }),
          warning({ kind: 'dropped_blocks', severity: 'needs_review', raw: 'Section 2 dropped.', acknowledged: true }),
        ],
        { onAcknowledge },
      );
      await userEvent.click(screen.getByText('Content the model may have dropped'));

      expect(screen.getByText('1 of 2 reviewed')).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'Fine as is' }));
      expect(onAcknowledge).toHaveBeenLastCalledWith('dropped_blocks', ['Section 1 dropped.'], true);

      await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
      expect(onAcknowledge).toHaveBeenLastCalledWith('dropped_blocks', ['Section 2 dropped.'], false);
    });
  });

  describe('retry enhancement', () => {
    const failed = (pass: string, nodeIds: string[]) =>
      warning({ kind: 'enhancement_call_failed', severity: 'pipeline_issue', raw: `${pass} failed`, nodeIds, detail: { pass } });

    it('offers Retry enhancement and hands over the affected items grouped by the pass that failed', async () => {
      const onRetryEnhancement = vi.fn();
      renderWarnings([failed('title_tag', ['a', 'b']), failed('synthesis', ['c'])], { onRetryEnhancement });

      await userEvent.click(screen.getByRole('button', { name: 'Retry enhancement' }));

      expect(onRetryEnhancement).toHaveBeenCalledWith('enhancement_call_failed', [
        { pass: 'title_tag', localIds: ['a', 'b'] },
        { pass: 'synthesis', localIds: ['c'] },
      ]);
    });

    it('offers no retry for a parent_summary failure, another kind, or without a handler', () => {
      const { unmount } = renderWarnings([failed('parent_summary', ['a'])], { onRetryEnhancement: vi.fn() });
      expect(screen.queryByRole('button', { name: 'Retry enhancement' })).not.toBeInTheDocument();
      unmount();

      const second = renderWarnings([warning({ kind: 'scoring_failed', severity: 'pipeline_issue', raw: 'x', nodeIds: ['a'], detail: { pass: 'synthesis' } })], {
        onRetryEnhancement: vi.fn(),
      });
      expect(screen.queryByRole('button', { name: 'Retry enhancement' })).not.toBeInTheDocument();
      second.unmount();

      renderWarnings([failed('synthesis', ['a'])]);
      expect(screen.queryByRole('button', { name: 'Retry enhancement' })).not.toBeInTheDocument();
    });

    it('shows progress and a Stop button while it runs, in place of the Retry button', async () => {
      const onCancelRetry = vi.fn();
      renderWarnings([failed('synthesis', ['a', 'b'])], {
        onRetryEnhancement: vi.fn(),
        onCancelRetry,
        retryProgress: { kind: 'enhancement_call_failed', done: 100, total: 275 },
      });

      expect(screen.getByText('Retrying: 100 of 275')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Retry enhancement' })).not.toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
      expect(onCancelRetry).toHaveBeenCalledTimes(1);
    });

    it('disables the Retry button on a different kind while another retry is running', () => {
      renderWarnings(
        [
          failed('synthesis', ['a']),
          warning({ kind: 'enhancement_response_incomplete', severity: 'auto_fixed', raw: 'x', nodeIds: ['b'], detail: { pass: 'title_tag' } }),
        ],
        { onRetryEnhancement: vi.fn(), retryProgress: { kind: 'enhancement_call_failed', done: 1, total: 5 } },
      );

      expect(screen.getByRole('button', { name: 'Retry enhancement' })).toBeDisabled();
    });
  });
});
