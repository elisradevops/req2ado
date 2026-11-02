import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { SectionResults, type SectionResultEntry } from './SectionResults';

function entry(overrides: Partial<SectionResultEntry> = {}): SectionResultEntry {
  return { branchIndex: 0, sectionLabel: 'Intro', nodes: [], kbGrounded: false, kbCitations: [], ...overrides };
}

async function open(): Promise<void> {
  await userEvent.click(screen.getByRole('button', { name: /Section 1/ }));
}

describe('SectionResults KB note', () => {
  it('keeps the legacy wording when availability is unknown', async () => {
    render(<SectionResults items={[entry()]} />);
    await open();
    expect(screen.getByText('Not grounded against your knowledge base for this section.')).toBeInTheDocument();
  });

  it('reports files available when the section cited none', async () => {
    render(<SectionResults items={[entry({ kbFilesAvailable: 3 })]} />);
    await open();
    expect(screen.getByText('Not grounded against your knowledge base for this step (3 files available)')).toBeInTheDocument();
  });

  it('reports cited of available when grounded', async () => {
    render(
      <SectionResults
        items={[entry({ kbGrounded: true, kbCitations: [{ sourceFile: 'a.pdf', similarity: 0.9 }], kbFilesAvailable: 3 })]}
      />,
    );
    await open();
    expect(screen.getByText('Grounded against 1 of 3 KB files:')).toBeInTheDocument();
  });
});
