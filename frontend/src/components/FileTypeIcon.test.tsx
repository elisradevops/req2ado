import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DropBoxPrompt } from './DropBoxPrompt';
import { FileTypeFan, FileTypeIcon, FileTypeLegend, fileKindOf, fileTypeGroups, fileTypeLabel } from './FileTypeIcon';
import { FILE_TYPE_GLYPHS } from './fileTypeGlyphs.generated';

// Fluent 2 System Icons, one consistent style, each kind in its own colour (owner decision, 2026-11-27).
describe('fileKindOf', () => {
  it.each([
    ['docx', 'Word'],
    ['DOC', 'Word'],
    ['.pdf', 'PDF'],
    ['xlsx', 'Excel'],
    ['csv', 'Excel'],
    ['pptx', 'PowerPoint'],
    ['txt', 'Text'],
    ['md', 'Text'],
    ['rtf', 'Rich text'],
    ['png', 'Images'],
    ['zip', 'Archives'],
    ['json', 'Code'],
    ['msg', 'Email'],
    ['mp4', 'Video'],
    ['mp3', 'Audio'],
    ['unknownext', 'Other'],
  ])('reads .%s as %s', (extension, name) => {
    expect(fileKindOf(extension).name).toBe(name);
  });

  it('reads a folder as a folder, whatever its name', () => {
    expect(fileKindOf('pdf', true).name).toBe('Folder');
  });
});

describe('FileTypeIcon', () => {
  function svgOf(container: HTMLElement): SVGElement {
    return container.querySelector('svg')!;
  }

  it('draws the kind glyph in its colour, hidden from screen readers, at Microsoft native 20 px drawing in a row', () => {
    const { container } = render(<FileTypeIcon extension="pdf" className="h-5 w-5" />);
    const svg = svgOf(container);
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg).toHaveAttribute('viewBox', '0 0 20 20');
    expect(svg.getAttribute('style')).toContain('color');
    expect(svg.querySelector('path')!.getAttribute('d')).toBe(FILE_TYPE_GLYPHS.documentPdf[20][0]);
  });

  it('sets a large icon on a tile of its colour, with the 32 px drawing', () => {
    const { container } = render(<FileTypeIcon extension="docx" tile className="h-12 w-12" />);
    const tile = container.firstElementChild as HTMLElement;
    expect(tile).toHaveAttribute('aria-hidden', 'true');
    expect(tile.style.backgroundColor).not.toBe('');
    expect(svgOf(container)).toHaveAttribute('viewBox', '0 0 32 32');
  });

  it('scales a glyph Microsoft draws only at 20 px when it sits on a tile', () => {
    const { container } = render(<FileTypeIcon extension="json" tile className="h-12 w-12" />);
    expect(svgOf(container)).toHaveAttribute('viewBox', '0 0 20 20');
  });

  it('labels a type by its extension', () => {
    expect(['pptx', '.rtf', 'png'].map(fileTypeLabel)).toEqual(['PPTX', 'RTF', 'PNG']);
  });
});

describe('FileTypeLegend', () => {
  it('shows the accepted types by group: equal tiles, each with its name and the extensions it takes', () => {
    render(<FileTypeLegend extensions={['docx', 'doc', 'pdf', 'xlsx', 'xls', 'csv', 'txt', 'md']} />);
    const list = screen.getByRole('list', { name: 'File types you can drop' });
    const items = within(list).getAllByRole('listitem');
    expect(items.map((li) => li.textContent)).toEqual(['Word.docx.doc', 'PDF.pdf', 'Excel.xlsx.xls.csv', 'Text.txt.md']);
    expect(items.every((li) => li.querySelector('svg[viewBox="0 0 32 32"]'))).toBe(true);
  });

  it('never hides an accepted extension: one in no group is listed under Other', () => {
    expect(fileTypeGroups(['pdf', 'vsdx']).map((g) => [g.name, g.extensions])).toEqual([
      ['PDF', ['pdf']],
      ['Other', ['vsdx']],
    ]);
  });
});

describe('FileTypeFan and DropBoxPrompt', () => {
  it('fans four tiles, decorative, and opens while a file is dragged over', () => {
    const { container, rerender } = render(<FileTypeFan open={false} />);
    const fan = container.querySelector('.file-fan')!;
    expect(fan).toHaveAttribute('aria-hidden', 'true');
    expect(fan.children).toHaveLength(4);
    expect(fan).not.toHaveAttribute('data-open');
    rerender(<FileTypeFan open />);
    expect(container.querySelector('.file-fan')).toHaveAttribute('data-open');
  });

  it('says what to drop and how, and to release while dragging', () => {
    const { rerender } = render(<DropBoxPrompt title="Drop your requirements document" dragging={false} choose="Choose a file" hint="up to 40 MB" extensions={['pdf']} />);
    expect(screen.getByText('Drop your requirements document')).toBeInTheDocument();
    expect(screen.getByText('· up to 40 MB')).toBeInTheDocument();
    // Drawn as a button for the eye, but not a second control inside the drop box.
    expect(screen.queryByRole('button')).toBeNull();
    rerender(<DropBoxPrompt title="Drop your requirements document" dragging choose="Choose a file" hint="up to 40 MB" extensions={['pdf']} />);
    expect(screen.getByText('Release to upload')).toBeInTheDocument();
  });
});
