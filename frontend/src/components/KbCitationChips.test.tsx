import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { KbCitationChips } from './KbCitationChips';

describe('KbCitationChips', () => {
  it('renders a "Relevant" label for a relevant citation', () => {
    render(<KbCitationChips citations={[{ sourceFile: 'doc-a.docx', similarity: 0.9, relevance: 'relevant' }]} />);
    expect(screen.getByText('Relevant · doc-a.docx')).toBeInTheDocument();
  });

  it('renders a "Not relevant" label for a not_relevant citation', () => {
    render(<KbCitationChips citations={[{ sourceFile: 'doc-b.pdf', similarity: 0.4, relevance: 'not_relevant' }]} />);
    expect(screen.getByText('Not relevant · doc-b.pdf')).toBeInTheDocument();
  });

  it('renders an "Unverified" label for an unknown-relevance citation', () => {
    render(<KbCitationChips citations={[{ sourceFile: 'doc-c.docx', similarity: 0.6, relevance: 'unknown' }]} />);
    expect(screen.getByText('Unverified · doc-c.docx')).toBeInTheDocument();
  });

  it('renders one chip per citation, in order', () => {
    render(
      <KbCitationChips
        citations={[
          { sourceFile: 'doc-a.docx', similarity: 0.9, relevance: 'relevant' },
          { sourceFile: 'doc-b.pdf', similarity: 0.4, relevance: 'not_relevant' },
        ]}
      />,
    );
    expect(screen.getByText('Relevant · doc-a.docx')).toBeInTheDocument();
    expect(screen.getByText('Not relevant · doc-b.pdf')).toBeInTheDocument();
  });

  it('renders nothing for an empty or undefined citations list', () => {
    const { container: emptyContainer } = render(<KbCitationChips citations={[]} />);
    expect(emptyContainer.querySelectorAll('span').length).toBe(0);
    const { container: undefinedContainer } = render(<KbCitationChips citations={undefined} />);
    expect(undefinedContainer.querySelectorAll('span').length).toBe(0);
  });

  it('uses the ok-token CSS variables for a relevant chip, not a hardcoded hex', () => {
    render(<KbCitationChips citations={[{ sourceFile: 'doc-a.docx', similarity: 0.9, relevance: 'relevant' }]} />);
    const chip = screen.getByText('Relevant · doc-a.docx').closest('span');
    expect(chip).toHaveStyle({ backgroundColor: 'var(--color-ok-soft)', color: 'var(--color-ok-ink)' });
  });

  it('uses the danger-token CSS variables for a not_relevant chip, not a hardcoded hex', () => {
    render(<KbCitationChips citations={[{ sourceFile: 'doc-b.pdf', similarity: 0.4, relevance: 'not_relevant' }]} />);
    const chip = screen.getByText('Not relevant · doc-b.pdf').closest('span');
    expect(chip).toHaveStyle({ backgroundColor: 'var(--color-danger-soft)', color: 'var(--color-danger-ink)' });
  });
  it('labels an always-included file "Always included", in the relevant (ok) colors', () => {
    render(<KbCitationChips citations={[{ sourceFile: 'guide.pptx', similarity: 1, relevance: 'relevant', inclusion: 'always' }]} />);
    const chip = screen.getByText('Always included · guide.pptx').closest('span');
    expect(chip).toHaveStyle({ backgroundColor: 'var(--color-ok-soft)', color: 'var(--color-ok-ink)' });
    expect(screen.queryByText(/^Relevant ·/)).not.toBeInTheDocument();
  });

  it('shows no similarity score in the tooltip of an always-included file', async () => {
    render(<KbCitationChips citations={[{ sourceFile: 'guide.pptx', similarity: 1, relevance: 'relevant', inclusion: 'always' }]} />);
    await userEvent.hover(screen.getByText('Always included · guide.pptx'));
    const tips = await screen.findAllByText(/included in full in every survey/i);
    expect(tips.length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toMatch(/100%/);
  });

  it('shows the closest-passage match score, without an excuse, for a retrieved citation', async () => {
    render(<KbCitationChips citations={[{ sourceFile: 'doc-b.pdf', similarity: 0.33, relevance: 'not_relevant', inclusion: 'retrieved' }]} />);
    await userEvent.hover(screen.getByText('Not relevant · doc-b.pdf'));
    const tips = await screen.findAllByText('Judged not relevant -- closest-passage match: 33%');
    expect(tips.length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toMatch(/process\/style guide/);
  });

  it('treats a citation with no inclusion (older job) as retrieved', () => {
    render(<KbCitationChips citations={[{ sourceFile: 'doc-a.docx', similarity: 0.9, relevance: 'relevant' }]} />);
    expect(screen.getByText('Relevant · doc-a.docx')).toBeInTheDocument();
  });
});
