import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { CollapsibleWarnings } from './CollapsibleWarnings';

function renderWarnings(warnings: string[]) {
  return render(
    <MemoryRouter>
      <CollapsibleWarnings warnings={warnings} />
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
});
