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
  // Regression guard: today's pre-rewrite ingestion shape (bare <table>, no
  // thead/th, no attributes) must keep working under the new DOMParser-based
  // renderer with zero special-casing -- the implicit-<tbody> HTML5
  // tree-construction behavior this relies on is exercised here.
  it('renders a trusted _table_to_html fragment as a real table, not escaped text', () => {
    const description = '<table><tr><td>Pin</td><td>Signal</td></tr><tr><td>1</td><td>VCC</td></tr></table>';
    render(<DescriptionMarkdown>{description}</DescriptionMarkdown>);
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getAllByRole('row')).toHaveLength(2);
    expect(screen.getByText('Signal')).toBeInTheDocument();
    expect(screen.queryByText(/&lt;table&gt;/)).not.toBeInTheDocument();
  });

  // DOMParser's own HTML parsing decodes entities as part of .textContent --
  // there's no longer a hand-rolled unescape step, so this now proves the
  // browser's native decoding is doing the job the old regex-based
  // unescapeHtmlEntities used to do by hand.
  it('decodes html.escape-produced entities in trusted table cells via DOMParser', () => {
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

  // A cell containing literal escaped source text (exactly what
  // html.escape() produces for a cell whose real content happens to look
  // like markup) must render as inert text under the new DOMParser-based
  // walk too, not just under the old regex slicer -- .textContent decodes
  // the entities to a plain string, and React's normal text-child rendering
  // re-escapes that string safely on output.
  it('renders a <script>-look-alike cell as inert text, never an executed/injected script', () => {
    const description = '<table><tr><td>&lt;script&gt;alert(1)&lt;/script&gt;</td></tr></table>';
    render(<DescriptionMarkdown>{description}</DescriptionMarkdown>);
    expect(document.querySelector('script')).not.toBeInTheDocument();
    expect(screen.getByText('<script>alert(1)</script>')).toBeInTheDocument();
  });

  it('renders <thead>/<th> as real column headers, distinct from body <td> cells', () => {
    const description =
      '<table><thead><tr><th>Pin</th><th>Signal</th></tr></thead><tbody><tr><td>1</td><td>VCC</td></tr></tbody></table>';
    render(<DescriptionMarkdown>{description}</DescriptionMarkdown>);
    const headers = screen.getAllByRole('columnheader');
    expect(headers).toHaveLength(2);
    expect(headers.map((h) => h.textContent)).toEqual(['Pin', 'Signal']);
    expect(screen.getByText('VCC').tagName).toBe('TD');
  });

  it('renders <caption> as the table caption', () => {
    const description = '<table><caption>Pinout</caption><tbody><tr><td>1</td></tr></tbody></table>';
    const { container } = render(<DescriptionMarkdown>{description}</DescriptionMarkdown>);
    const caption = container.querySelector('caption');
    expect(caption).not.toBeNull();
    expect(caption?.textContent).toBe('Pinout');
  });

  it('passes colspan/rowspan through as real HTML attributes on the rendered cell', () => {
    const description = '<table><tbody><tr><td colspan="2" rowspan="3">merged</td><td>x</td></tr></tbody></table>';
    render(<DescriptionMarkdown>{description}</DescriptionMarkdown>);
    const mergedCell = screen.getByText('merged') as HTMLTableCellElement;
    expect(mergedCell.tagName).toBe('TD');
    expect(mergedCell.colSpan).toBe(2);
    expect(mergedCell.rowSpan).toBe(3);
  });

  // The core structural invariant from the design spec: a grid position
  // SPANNED by a preceding cell's colspan/rowspan has NO <td>/<th> at all in
  // the source markup (and must render NO extra cell), while a genuine gap
  // (source had literally nothing there) DOES get an empty <td> in the
  // source markup (and must render an empty cell). Asserting on cell COUNT
  // per row -- not just content -- is what actually distinguishes these two
  // cases; a content-only assertion would pass even if they were conflated.
  it('renders no extra cell for a spanned position, but a real empty cell for a genuine gap', () => {
    const description =
      '<table><tbody>' +
      // Row 1: colspan="2" cell covers 2 grid columns using only 2 <td>s in
      // the markup (the spanned position has no corresponding element at
      // all) -- 3 grid columns total, only 2 real <td> elements.
      '<tr><td colspan="2">wide</td><td>c</td></tr>' +
      // Row 2: a genuine gap -- 3 real <td> elements, the middle one empty.
      '<tr><td>a</td><td></td><td>c</td></tr>' +
      '</tbody></table>';
    const { container } = render(<DescriptionMarkdown>{description}</DescriptionMarkdown>);
    const rows = container.querySelectorAll('tbody tr');
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelectorAll('td')).toHaveLength(2); // spanned position produced NO extra cell
    expect(rows[1].querySelectorAll('td')).toHaveLength(3); // genuine gap DID produce an (empty) cell
    expect(rows[1].querySelectorAll('td')[1].textContent).toBe('');
  });

  it('applies a valid text-align style from the closed enum', () => {
    const description = '<table><tbody><tr><td style="text-align:center">x</td></tr></tbody></table>';
    render(<DescriptionMarkdown>{description}</DescriptionMarkdown>);
    const cell = screen.getByText('x') as HTMLTableCellElement;
    expect(cell.style.textAlign).toBe('center');
  });

  it('ignores an out-of-enum text-align value instead of passing it through', () => {
    const description = '<table><tbody><tr><td style="text-align:sneaky">x</td></tr></tbody></table>';
    render(<DescriptionMarkdown>{description}</DescriptionMarkdown>);
    const cell = screen.getByText('x') as HTMLTableCellElement;
    expect(cell.style.textAlign).toBe('');
  });

  // Defense-in-depth per the design spec: even though ingestion is "trusted"
  // in principle, a hand-crafted/malicious style value must never reach the
  // rendered element. Only `text-align` is ever read out of the attribute --
  // anything else (a background, a javascript: URL riding along in a CSS
  // value) is dropped entirely, not merely reformatted.
  it('never passes an injected style declaration through, even alongside a real property', () => {
    const description = '<table><tbody><tr><td style="background:url(javascript:alert(1));text-align:center">x</td></tr></tbody></table>';
    render(<DescriptionMarkdown>{description}</DescriptionMarkdown>);
    const cell = screen.getByText('x') as HTMLTableCellElement;
    expect(cell.style.textAlign).toBe('center'); // the one allowlisted property still comes through
    expect(cell.style.background).toBe(''); // everything else is silently dropped, not passed through
  });
});
