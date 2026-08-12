import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
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
});
