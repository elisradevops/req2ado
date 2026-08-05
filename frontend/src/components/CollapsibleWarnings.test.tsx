import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { CollapsibleWarnings } from './CollapsibleWarnings';

function renderWarnings(
  warnings: string[],
  onJumpToNode?: (localId: string) => void,
  adoIdByLocalId?: Record<string, number>,
  orgUrl?: string | null,
  project?: string | null,
) {
  return render(
    <MemoryRouter>
      <CollapsibleWarnings
        warnings={warnings}
        onJumpToNode={onJumpToNode}
        adoIdByLocalId={adoIdByLocalId}
        orgUrl={orgUrl}
        project={project}
      />
    </MemoryRouter>,
  );
}

describe('CollapsibleWarnings', () => {
  it('renders nothing when there are no warnings', () => {
    const { container } = renderWarnings([]);
    expect(container.firstChild).toBeNull();
  });

  it('groups dropped-block and external-reference warnings under separate, labeled headers', async () => {
    renderWarnings([
      'SURVEY analysis did not reference 2 of 5 source block(s), and their content does not appear (even paraphrased) in any generated node -- likely dropped, not merged: [1, 2]',
      "Section br0_ references an external artifact ('ReqID') this SURVEY run did not ingest -- consider adding it to the knowledge base.",
    ]);

    await userEvent.click(screen.getByText(/2 integrity warnings/i));

    expect(screen.getByText('Content the model may have dropped')).toBeInTheDocument();
    expect(screen.getByText('References to documents not in your knowledge base')).toBeInTheDocument();
  });

  it('shows an actionable link to the knowledge base only for external-reference warnings', async () => {
    renderWarnings([
      "Section br0_ references an external artifact ('ReqID') this SURVEY run did not ingest -- consider adding it to the knowledge base.",
    ]);

    await userEvent.click(screen.getByText(/1 integrity warning/i));
    await userEvent.click(screen.getByText('References to documents not in your knowledge base'));

    const link = screen.getByRole('link', { name: /add to knowledge base/i });
    expect(link).toHaveAttribute('href', '/knowledge-base');
  });

  it('falls back every other warning kind into a single "Other analysis notices" group', async () => {
    renderWarnings([
      'Model output was truncated by the token limit -- results may be incomplete; consider raising the model\'s output cap.',
      "Quality scoring returned no valid score for 1 node(s) in branch 'br0_': ['br0_n33']",
    ]);

    await userEvent.click(screen.getByText(/2 integrity warnings/i));

    expect(screen.getByText('Other analysis notices')).toBeInTheDocument();
    expect(screen.queryByText('Content the model may have dropped')).not.toBeInTheDocument();
    expect(screen.queryByText('References to documents not in your knowledge base')).not.toBeInTheDocument();
  });

  it('shows a why/what-to-do tip once per group, not once per warning', async () => {
    renderWarnings([
      'SURVEY analysis did not reference 2 of 5 source block(s), and their content does not appear (even paraphrased) in any generated node -- likely dropped, not merged: [1, 2]',
      'SURVEY analysis did not reference 3 of 9 source block(s), and their content does not appear (even paraphrased) in any generated node -- likely dropped, not merged: [4, 5, 6]',
    ]);

    await userEvent.click(screen.getByText(/2 integrity warnings/i));
    await userEvent.click(screen.getByText('Content the model may have dropped'));

    expect(screen.getAllByText(/under-synthesized/i).length).toBe(1);
  });

  it('groups near-duplicate conflict warnings and offers a jump-to-node action per referenced item', async () => {
    const onJumpToNode = vi.fn();
    renderWarnings(
      [
        "Near-duplicate items 'Power supply efficiency' [localId: n0], 'Power supply efficiency (appendix)' [localId: n1] appear to state conflicting values for the same parameter (['85%', '93%']) -- resolve before this can be finalized.",
      ],
      onJumpToNode,
    );

    await userEvent.click(screen.getByText(/1 integrity warning/i));
    await userEvent.click(screen.getByText('Near-duplicate items with conflicting values'));

    const jumpButtons = screen.getAllByRole('button', { name: /review item/i });
    expect(jumpButtons).toHaveLength(2);

    await userEvent.click(jumpButtons[0]);
    expect(onJumpToNode).toHaveBeenCalledWith('n0');

    await userEvent.click(jumpButtons[1]);
    expect(onJumpToNode).toHaveBeenCalledWith('n1');
  });

  it('links to the real ADO work item for a conflict item that already exists there, alongside the jump-to-node action', async () => {
    // Real gap this closes (user-reported): "[localId: n1]" is an internal,
    // this-run-only reference -- for a near-duplicate that's already a
    // real ADO work item (dedup_skip/reuse), there was previously no way
    // to find the ACTUAL item to verify the conflict against.
    renderWarnings(
      [
        "Near-duplicate items 'RS-232 Receiver Support' [localId: n0], 'LVCMOS Driver Support' [localId: n1] appear to state conflicting values for the same parameter (['eight RS-232', 'eight LVCMOS']) -- resolve before this can be finalized.",
      ],
      vi.fn(),
      { n1: 604 }, // only n1 already exists in ADO -- n0 is a plain 'create'
      'https://dev.azure.com/example-org',
    );

    await userEvent.click(screen.getByText(/1 integrity warning/i));
    await userEvent.click(screen.getByText('Near-duplicate items with conflicting values'));

    expect(screen.getAllByRole('button', { name: /review item/i })).toHaveLength(2); // still offered for both
    const adoLink = screen.getByRole('link', { name: /view wi #604 in azure devops/i });
    expect(adoLink).toHaveAttribute('href', 'https://dev.azure.com/example-org/_workitems/edit/604');
    expect(screen.queryByRole('link', { name: /view wi #.*n0/i })).not.toBeInTheDocument();
  });

  it('includes the project segment in the ADO link when project is provided', async () => {
    renderWarnings(
      [
        "Near-duplicate items 'RS-232 Receiver Support' [localId: n0], 'LVCMOS Driver Support' [localId: n1] appear to state conflicting values for the same parameter (['eight RS-232', 'eight LVCMOS']) -- resolve before this can be finalized.",
      ],
      vi.fn(),
      { n1: 604 },
      'https://dev.azure.com/example-org',
      'elisradevops-project',
    );

    await userEvent.click(screen.getByText(/1 integrity warning/i));
    await userEvent.click(screen.getByText('Near-duplicate items with conflicting values'));

    const adoLink = screen.getByRole('link', { name: /view wi #604 in azure devops/i });
    expect(adoLink).toHaveAttribute('href', 'https://dev.azure.com/example-org/elisradevops-project/_workitems/edit/604');
  });

  it('offers no ADO link for a conflict item that is still only a proposed create', async () => {
    renderWarnings(
      [
        "Near-duplicate items 'A' [localId: n0], 'B' [localId: n1] appear to state conflicting values for the same parameter (['x', 'y']) -- resolve before this can be finalized.",
      ],
      vi.fn(),
      {}, // neither n0 nor n1 exists in ADO yet
      'https://dev.azure.com/example-org',
    );

    await userEvent.click(screen.getByText(/1 integrity warning/i));
    await userEvent.click(screen.getByText('Near-duplicate items with conflicting values'));

    expect(screen.queryByRole('link', { name: /view wi/i })).not.toBeInTheDocument();
  });
});
