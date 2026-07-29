import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Markdown } from './Markdown';

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
});
