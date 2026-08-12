import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SourceProvenance } from './SourceProvenance';

describe('SourceProvenance', () => {
  it('renders the file row (basename only, not the full path) when sourceRef is present', () => {
    render(
      <SourceProvenance
        sourceRef={{ documentPath: 'folder/spec.docx', startOffset: 0, endOffset: 10, page: null }}
        showScoringNote={false}
      />,
    );
    expect(screen.getByText('spec.docx')).toBeInTheDocument();
    expect(screen.queryByText('folder/spec.docx')).not.toBeInTheDocument();
  });

  it('renders nothing at all when sourceRef is null and showScoringNote is false and there are no citations', () => {
    const { container } = render(<SourceProvenance sourceRef={null} showScoringNote={false} />);
    expect(container.textContent).toBe('');
  });

  it('renders a Section row when sectionPath is present', () => {
    render(
      <SourceProvenance
        sourceRef={{ documentPath: 'spec.docx', startOffset: 0, endOffset: 10, page: null, sectionPath: ['3 Power', '3.2 Backplane'] }}
        showScoringNote={false}
      />,
    );
    expect(screen.getByText('Section')).toBeInTheDocument();
    expect(screen.getByText('3 Power > 3.2 Backplane')).toBeInTheDocument();
  });

  it('renders a Page row when page is present, and omits Section when sectionPath is absent', () => {
    render(
      <SourceProvenance sourceRef={{ documentPath: 'spec.docx', startOffset: 0, endOffset: 10, page: 13 }} showScoringNote={false} />,
    );
    expect(screen.getByText('Page')).toBeInTheDocument();
    expect(screen.getByText('13')).toBeInTheDocument();
    expect(screen.queryByText('Section')).not.toBeInTheDocument();
  });

  it('renders neither Section nor Page when sourceRef has no page and no sectionPath (the XLSX-today case)', () => {
    render(<SourceProvenance sourceRef={{ documentPath: 'sheet.xlsx', startOffset: 0, endOffset: 0, page: null }} showScoringNote={false} />);
    expect(screen.getByText('sheet.xlsx')).toBeInTheDocument();
    expect(screen.queryByText('Section')).not.toBeInTheDocument();
    expect(screen.queryByText('Page')).not.toBeInTheDocument();
  });

  it('renders the one-line scoring note only when showScoringNote is true', () => {
    const { rerender } = render(<SourceProvenance sourceRef={null} showScoringNote={true} />);
    expect(screen.getByText('Scored on wording only, not engineering content.')).toBeInTheDocument();

    rerender(<SourceProvenance sourceRef={null} showScoringNote={false} />);
    expect(screen.queryByText('Scored on wording only, not engineering content.')).not.toBeInTheDocument();
  });

  it('renders KB references heading and chips only when kbCitations is non-empty', () => {
    const { rerender } = render(<SourceProvenance sourceRef={null} showScoringNote={false} kbCitations={[]} />);
    expect(screen.queryByText('KB references')).not.toBeInTheDocument();

    rerender(
      <SourceProvenance
        sourceRef={null}
        showScoringNote={false}
        kbCitations={[{ sourceFile: 'doc-a.docx', similarity: 0.9, relevance: 'relevant' }]}
      />,
    );
    expect(screen.getByText('KB references')).toBeInTheDocument();
    expect(screen.getByText('Relevant · doc-a.docx')).toBeInTheDocument();
  });

  it('uses the "Slide" label end to end for a pptx-sourced entry', () => {
    render(<SourceProvenance sourceRef={{ documentPath: 'deck.pptx', startOffset: 0, endOffset: 0, page: 4 }} showScoringNote={false} />);
    expect(screen.getByText('Slide')).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument();
  });
});
