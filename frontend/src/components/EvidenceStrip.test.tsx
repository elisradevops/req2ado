import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EvidenceStrip } from './EvidenceStrip';
import type { DryRunDiffEntry } from './DiffTree';

const BASE: DryRunDiffEntry = {
  localId: 'e1', parentLocalId: null, type: 'Requirement', title: 'T', description: 'D', action: 'create', customerId: null,
};
const REF = { documentPath: 'folder/spec.docx', startOffset: 0, endOffset: 9, page: 4, sectionPath: ['3 Power'] };

describe('EvidenceStrip', () => {
  it('shows file, location and the honest no-excerpt line', () => {
    render(<EvidenceStrip entry={{ ...BASE, sourceRef: REF }} jobMode="survey" />);
    expect(screen.getByRole('region', { name: 'Evidence' })).toBeInTheDocument();
    expect(screen.getByText('spec.docx')).toBeInTheDocument();
    expect(screen.getByText('3 Power')).toBeInTheDocument();
    expect(screen.getByText(/source text is not stored/i)).toBeInTheDocument();
  });

  it('says there is no recorded location when the entry has no sourceRef', () => {
    render(<EvidenceStrip entry={BASE} jobMode="baseline" />);
    expect(screen.getByText(/no source location recorded/i)).toBeInTheDocument();
    expect(screen.queryByText(/source text is not stored/i)).not.toBeInTheDocument();
  });

  it('names the weakest category with its score and the checklist text', () => {
    render(
      <EvidenceStrip
        entry={{
          ...BASE,
          sourceRef: REF,
          qualityScore: 62,
          qualityCategoryScores: { clarity: 80, testability: 35 },
          qualityCategoryChecklist: { testability: 'Each requirement has a pass/fail test.' },
        }}
        jobMode="survey"
      />,
    );
    expect(screen.getByText(/Weakest area/)).toBeInTheDocument();
    expect(screen.getByText('Testability')).toBeInTheDocument();
    expect(screen.getByText('35')).toBeInTheDocument();
    expect(screen.getByText(/Each requirement has a pass\/fail test\./)).toBeInTheDocument();
  });

  it('reads the weakest area as a sentence for a screen reader, not as loose words and a number', () => {
    const { container } = render(
      <EvidenceStrip entry={{ ...BASE, qualityCategoryScores: { testability: 35, clarity: 80 } }} jobMode="survey" />,
    );
    const row = screen.getByText('Weakest area').parentElement as HTMLElement;
    expect(row.textContent).toBe('Weakest area: Testability, 35 of 100');
    // The punctuation is for assistive tech only: it must not show.
    expect(Array.from(container.querySelectorAll('.sr-only')).map((e) => e.textContent)).toEqual([': ', ', ']);
  });

  it('shows a weakest category of 0 rather than treating it as missing', () => {
    render(<EvidenceStrip entry={{ ...BASE, qualityCategoryScores: { style: 0, clarity: 90 } }} jobMode="survey" />);
    expect(screen.getByText('Style')).toBeInTheDocument();
    expect(screen.getByText('0')).toBeInTheDocument();
  });

  it('says nothing about scoring when there are no category scores (the details pane owns that state)', () => {
    render(<EvidenceStrip entry={BASE} jobMode="baseline" />);
    expect(screen.queryByText(/not scored/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Weakest area/)).not.toBeInTheDocument();
  });

  it('shows no weakest area and no stale note for stale scores (the details pane already says so)', () => {
    render(<EvidenceStrip entry={{ ...BASE, qualityStale: true, qualityCategoryScores: { clarity: 10 } }} jobMode="survey" />);
    expect(screen.queryByText(/Weakest area/)).not.toBeInTheDocument();
    expect(screen.queryByText(/out of date/i)).not.toBeInTheDocument();
  });

  it('shows KB citations when given', () => {
    render(
      <EvidenceStrip
        entry={{ ...BASE, sourceRef: REF }}
        jobMode="survey"
        kbCitations={[{ sourceFile: 'style-guide.pdf', similarity: 0.4, relevance: 'relevant' }]}
      />,
    );
    expect(screen.getByText(/style-guide\.pdf/)).toBeInTheDocument();
  });

  it('renders no empty "Source" label or file row for citations or the scoring note without a sourceRef', () => {
    const { container } = render(
      <EvidenceStrip
        entry={{ ...BASE, qualityScore: 80 }}
        jobMode="survey"
        kbCitations={[{ sourceFile: 'style-guide.pdf', similarity: 0.4, relevance: 'relevant' }]}
      />,
    );
    expect(screen.queryByText(/^sources?$/i)).not.toBeInTheDocument();
    expect(container.querySelector('dl')).toBeNull();
    expect(screen.getByText('KB references')).toBeInTheDocument();
    expect(screen.getByText(/scored on wording only/i)).toBeInTheDocument();
  });

  describe('scoring note (SURVEY create Requirement with a fresh score only)', () => {
    const NOTE = /scored on wording only/i;

    it('shows the note and still the no-location line for a SURVEY create Requirement with a score, no source and no citations', () => {
      render(<EvidenceStrip entry={{ ...BASE, qualityScore: 80 }} jobMode="survey" />);
      expect(screen.getByText(NOTE)).toBeInTheDocument();
      expect(screen.getByText(/no source location recorded/i)).toBeInTheDocument();
    });

    it('shows no note for stale scores, and stays silent about the weakest area', () => {
      render(<EvidenceStrip entry={{ ...BASE, sourceRef: REF, qualityScore: 80, qualityStale: true, qualityCategoryScores: { clarity: 10 } }} jobMode="survey" />);
      expect(screen.queryByText(NOTE)).not.toBeInTheDocument();
      expect(screen.queryByText(/Weakest area/)).not.toBeInTheDocument();
    });

    it('shows no note for an unscored SURVEY Requirement with a source location', () => {
      render(<EvidenceStrip entry={{ ...BASE, sourceRef: REF }} jobMode="survey" />);
      expect(screen.queryByText(NOTE)).not.toBeInTheDocument();
      expect(screen.queryByText(/Weakest area/)).not.toBeInTheDocument();
    });

    it('shows no note for BASELINE or unknown mode', () => {
      const { unmount } = render(<EvidenceStrip entry={{ ...BASE, qualityScore: 80, sourceRef: REF }} jobMode="baseline" />);
      expect(screen.queryByText(NOTE)).not.toBeInTheDocument();
      unmount();
      render(<EvidenceStrip entry={{ ...BASE, qualityScore: 80, sourceRef: REF }} jobMode={null} />);
      expect(screen.queryByText(NOTE)).not.toBeInTheDocument();
    });

    it.each(['Epic', 'Feature'])('shows no note for a SURVEY %s', (type) => {
      render(<EvidenceStrip entry={{ ...BASE, type, qualityScore: 80, sourceRef: REF }} jobMode="survey" />);
      expect(screen.queryByText(NOTE)).not.toBeInTheDocument();
    });

    it('shows no note for a SURVEY Requirement with action reuse', () => {
      render(<EvidenceStrip entry={{ ...BASE, action: 'reuse', qualityScore: 80, sourceRef: REF }} jobMode="survey" />);
      expect(screen.queryByText(NOTE)).not.toBeInTheDocument();
    });
  });

  it('marks free text and inline IDs for right-to-left safety', () => {
    render(
      <EvidenceStrip
        entry={{
          ...BASE,
          sourceRef: { ...REF, sectionPath: ['דרישות הספק'] },
          qualityCategoryScores: { testability: 20 },
          qualityCategoryChecklist: { testability: 'בדיקה' },
        }}
        jobMode="survey"
      />,
    );
    const checklist = screen.getByText(/בדיקה/);
    expect(checklist.tagName).toBe('P');
    expect(checklist).toHaveAttribute('dir', 'auto');
    expect(screen.getByText('דרישות הספק').closest('bdi')).not.toBeNull();
  });
});
