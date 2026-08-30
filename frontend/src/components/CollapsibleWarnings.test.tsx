import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { CollapsibleWarnings } from './CollapsibleWarnings';
import type { WarningRecord } from '../utils/warnings';

function warning(overrides: Partial<WarningRecord> & Pick<WarningRecord, 'kind' | 'severity' | 'raw'>): WarningRecord {
  return { nodeIds: [], detail: {}, ...overrides };
}

function renderWarnings(
  warnings: WarningRecord[],
  opts?: {
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
  it('auto-expands by default when a needs_review/pipeline_issue warning exists', () => {
    // Real gap this fixes (confirmed live): something the user actually
    // has to act on defaulted to collapsed, identical in weight to an
    // auto_fixed notice -- easy to scroll past without ever noticing it.
    renderWarnings([
      warning({ kind: 'low_grounding', severity: 'needs_review', raw: "Node n0's generated description has low grounding." }),
    ]);
    expect(screen.getByText('Low grounding -- possible fabrication')).toBeInTheDocument();
  });

  it('stays collapsed by default when every warning is auto_fixed', () => {
    renderWarnings([
      warning({ kind: 'reparented_to_feature', severity: 'auto_fixed', raw: '3 Requirement(s) were re-parented under Feature f0.' }),
    ]);
    expect(screen.queryByText('Re-parented under a Feature')).not.toBeInTheDocument();
  });

  it('renders nothing when there are no warnings', () => {
    const { container } = renderWarnings([]);
    expect(container.firstChild).toBeNull();
  });

  it('groups warnings by severity tier first, with a per-tier count', async () => {
    renderWarnings([
      warning({ kind: 'reparented_to_feature', severity: 'auto_fixed', raw: '3 Requirement(s) were re-parented under Feature f0.' }),
      warning({ kind: 'low_grounding', severity: 'needs_review', raw: "Node n0's generated description has low grounding." }),
      warning({ kind: 'zero_nodes', severity: 'pipeline_issue', raw: 'Section produced 0 work items.' }),
    ]);

    await userEvent.click(screen.getByText(/3 integrity warnings/i));

    expect(screen.getByText('Automatically fixed')).toBeInTheDocument();
    expect(screen.getByText('Needs your review')).toBeInTheDocument();
    expect(screen.getByText('Pipeline issue')).toBeInTheDocument();
  });

  it('groups by kind within a severity tier, showing the tip once per kind not once per warning', async () => {
    renderWarnings([
      warning({ kind: 'dropped_blocks', severity: 'needs_review', raw: 'SURVEY analysis did not reference 2 of 5 source block(s).' }),
      warning({ kind: 'dropped_blocks', severity: 'needs_review', raw: 'SURVEY analysis did not reference 3 of 9 source block(s).' }),
    ]);

    await userEvent.click(screen.getByText(/2 integrity warnings/i));

    expect(screen.getByText('Content the model may have dropped')).toBeInTheDocument();
    expect(screen.getAllByText(/under-synthesized/i).length).toBe(1);
    expect(screen.getByText('SURVEY analysis did not reference 2 of 5 source block(s).')).toBeInTheDocument();
    expect(screen.getByText('SURVEY analysis did not reference 3 of 9 source block(s).')).toBeInTheDocument();
  });

  it('renders a real title/tip for trace_link_write_failed, not the generic fallback', async () => {
    renderWarnings([
      warning({
        kind: 'trace_link_write_failed',
        severity: 'pipeline_issue',
        raw: '1 trace link failed to write to Azure DevOps and can be retried from the node detail panel.',
      }),
    ]);

    await userEvent.click(screen.getByText(/1 integrity warning/i));

    expect(screen.getByText('Trace links failed to write to Azure DevOps')).toBeInTheDocument();
    expect(screen.queryByText('See the sentence below for details.')).not.toBeInTheDocument();
  });

  it('falls back an unrecognized kind to a humanized title', async () => {
    renderWarnings([warning({ kind: 'some_future_kind', severity: 'needs_review', raw: 'A brand new kind of notice.' })]);

    await userEvent.click(screen.getByText(/1 integrity warning/i));

    expect(screen.getByText('Some Future Kind')).toBeInTheDocument();
  });

  it('shows an actionable link to the knowledge base only for external-reference warnings', async () => {
    renderWarnings([
      warning({
        kind: 'external_reference',
        severity: 'needs_review',
        raw: "Section br0_ references an external artifact ('ReqID') this SURVEY run did not ingest.",
      }),
    ]);

    await userEvent.click(screen.getByText(/1 integrity warning/i));
    await userEvent.click(screen.getByText('References to documents not in your knowledge base'));

    const link = screen.getByRole('link', { name: /add to knowledge base/i });
    expect(link).toHaveAttribute('href', '/knowledge-base');
  });

  it('marks a legacy (reclassified) warning distinctly from a freshly-classified one', async () => {
    renderWarnings([
      warning({ kind: 'other', severity: 'needs_review', raw: 'An old, unclassified warning.', legacy: true }),
    ]);

    await userEvent.click(screen.getByText(/1 integrity warning/i));

    expect(screen.getByText(/from an older run/i)).toBeInTheDocument();
  });

  it('offers a disambiguated jump-to-node button per referenced item, using the real item title', async () => {
    const onJumpToNode = vi.fn();
    renderWarnings(
      [
        warning({
          kind: 'near_duplicate_conflict',
          severity: 'needs_review',
          raw: "Near-duplicate items 'Power supply efficiency', 'Power supply efficiency (appendix)' appear to state conflicting values.",
          nodeIds: ['n0', 'n1'],
        }),
      ],
      { onJumpToNode, titleByLocalId: { n0: 'Power supply efficiency', n1: 'Power supply efficiency (appendix)' } },
    );

    await userEvent.click(screen.getByText(/1 integrity warning/i));

    // Real gap this closes (user-reported): two buttons both labeled
    // "Review item ->" read as duplicated UI -- each must now carry the
    // real item title so they're visually distinct.
    const reviewButtons = screen.getAllByRole('button', { name: /^review /i });
    expect(reviewButtons).toHaveLength(2);
    expect(reviewButtons[0]).toHaveAccessibleName('Review "Power supply efficiency" →');
    expect(reviewButtons[1]).toHaveAccessibleName('Review "Power supply efficiency (appendix)" →');

    await userEvent.click(reviewButtons[0]);
    expect(onJumpToNode).toHaveBeenCalledWith('n0');
  });

  it('falls back to an indexed label when no title is known for a referenced item', async () => {
    renderWarnings([
      warning({
        kind: 'near_duplicate_conflict',
        severity: 'needs_review',
        raw: "Near-duplicate items 'A', 'B' appear to state conflicting values.",
        nodeIds: ['n0', 'n1'],
      }),
    ], { onJumpToNode: vi.fn() });

    await userEvent.click(screen.getByText(/1 integrity warning/i));

    expect(screen.getByRole('button', { name: 'Review item 1 →' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Review item 2 →' })).toBeInTheDocument();
  });

  it('links to the real ADO work item for a conflict item that already exists there, alongside the jump-to-node action', async () => {
    renderWarnings(
      [
        warning({
          kind: 'near_duplicate_conflict',
          severity: 'needs_review',
          raw: "Near-duplicate items 'RS-232 Receiver Support', 'LVCMOS Driver Support' appear to state conflicting values.",
          nodeIds: ['n0', 'n1'],
        }),
      ],
      { onJumpToNode: vi.fn(), adoIdByLocalId: { n1: 604 }, orgUrl: 'https://dev.azure.com/example-org' },
    );

    await userEvent.click(screen.getByText(/1 integrity warning/i));

    expect(screen.getAllByRole('button', { name: /^review /i })).toHaveLength(2); // still offered for both
    const adoLink = screen.getByRole('link', { name: /view wi #604 in azure devops/i });
    expect(adoLink).toHaveAttribute('href', 'https://dev.azure.com/example-org/_workitems/edit/604');
  });

  it('includes the project segment in the ADO link when project is provided', async () => {
    renderWarnings(
      [
        warning({
          kind: 'near_duplicate_conflict',
          severity: 'needs_review',
          raw: "Near-duplicate items 'RS-232 Receiver Support', 'LVCMOS Driver Support' appear to state conflicting values.",
          nodeIds: ['n0', 'n1'],
        }),
      ],
      { onJumpToNode: vi.fn(), adoIdByLocalId: { n1: 604 }, orgUrl: 'https://dev.azure.com/example-org', project: 'elisradevops-project' },
    );

    await userEvent.click(screen.getByText(/1 integrity warning/i));

    const adoLink = screen.getByRole('link', { name: /view wi #604 in azure devops/i });
    expect(adoLink).toHaveAttribute('href', 'https://dev.azure.com/example-org/elisradevops-project/_workitems/edit/604');
  });

  it('offers no ADO link and no review buttons for a warning with no affected node ids', async () => {
    renderWarnings([warning({ kind: 'zero_nodes', severity: 'pipeline_issue', raw: 'Section produced 0 work items.' })], {
      onJumpToNode: vi.fn(),
      orgUrl: 'https://dev.azure.com/example-org',
    });

    await userEvent.click(screen.getByText(/1 integrity warning/i));

    expect(screen.queryByRole('button', { name: /review/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /view wi/i })).not.toBeInTheDocument();
  });
});
