import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Markdown, DescriptionMarkdown } from './Markdown';

describe('Markdown', () => {
  it('renders **bold** as <strong>', () => {
    render(<Markdown>{'**bold**'}</Markdown>);
    expect(screen.getByText('bold').tagName).toBe('STRONG');
  });

  it('renders *italic* as <em>', () => {
    render(<Markdown>{'*italic*'}</Markdown>);
    expect(screen.getByText('italic').tagName).toBe('EM');
  });

  it('renders ~~strikethrough~~ (a GFM extension) as <del>, not literal tildes', () => {
    // Regression guard: react-markdown only supports CommonMark without the
    // remarkGfm plugin -- confirmed live that omitting it left "~~text~~"
    // rendered as literal tildes instead of struck-through text.
    render(<Markdown>{'~~struck~~'}</Markdown>);
    expect(screen.getByText('struck').tagName).toBe('DEL');
    expect(screen.queryByText(/~~/)).not.toBeInTheDocument();
  });

  it('renders a nested unordered list with the correct item count', () => {
    render(<Markdown>{'- one\n- two\n  - two-a\n- three'}</Markdown>);
    expect(screen.getAllByRole('listitem')).toHaveLength(4);
  });

  it('renders raw HTML as literal text, not a real element (safe by construction)', () => {
    render(<Markdown>{'<span>not real</span>'}</Markdown>);
    expect(screen.queryByText('not real')).not.toBeInTheDocument();
    expect(screen.getByText(/<span>not real<\/span>/)).toBeInTheDocument();
  });
});

describe('DescriptionMarkdown', () => {
  it('renders a trusted _table_to_html fragment as a real table, not escaped text', () => {
    const description = '<table><tr><td>Pin</td><td>Signal</td></tr><tr><td>1</td><td>VCC</td></tr></table>';
    render(<DescriptionMarkdown>{description}</DescriptionMarkdown>);
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getAllByRole('row')).toHaveLength(2);
    expect(screen.getByText('Signal')).toBeInTheDocument();
    expect(screen.queryByText(/&lt;table&gt;/)).not.toBeInTheDocument();
  });

  it('unescapes html.escape-produced entities in trusted table cells', () => {
    const description = '<table><tr><td>A &amp; B</td><td>x &lt; y</td></tr></table>';
    render(<DescriptionMarkdown>{description}</DescriptionMarkdown>);
    expect(screen.getByText('A & B')).toBeInTheDocument();
    expect(screen.getByText('x < y')).toBeInTheDocument();
  });

  it('renders surrounding markdown prose around an embedded table (assemble_description join)', () => {
    const description = 'Some prose with **bold** text.\n<table><tr><td>cell</td></tr></table>';
    render(<DescriptionMarkdown>{description}</DescriptionMarkdown>);
    expect(screen.getByText('bold').tagName).toBe('STRONG');
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByText('cell')).toBeInTheDocument();
  });

  it('still renders non-table raw HTML as literal text, not a real element', () => {
    render(<DescriptionMarkdown>{'<script>alert(1)</script>'}</DescriptionMarkdown>);
    expect(document.querySelector('script')).not.toBeInTheDocument();
  });
});
