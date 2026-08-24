import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { WorkItemTypeBadge } from './WorkItemTypeBadge';

describe('WorkItemTypeBadge', () => {
  it('renders the fallback icon (no catalog entry) with the type label', () => {
    render(<WorkItemTypeBadge type="Epic" />);
    expect(screen.getByText('Epic')).toBeInTheDocument();
  });

  it('renders the real catalog icon as a non-draggable <img>', () => {
    const { container } = render(
      <WorkItemTypeBadge type="User Story" catalogEntry={{ color: '009CCC', iconDataUrl: 'data:image/svg+xml;base64,AAA' }} />,
    );
    // aria-hidden strips the implicit "img" role, so query the element
    // directly rather than by role.
    const img = container.querySelector('img')!;
    // Real bug (user-reported): <img> is natively draggable in every
    // browser regardless of any ancestor's own `draggable` attribute --
    // inside DiffTree's draggable rows (DESIGN.md §11.5), grabbing a row
    // directly on top of this icon started the browser's own image-drag
    // gesture instead of the row's custom row-move drag.
    expect(img).toHaveAttribute('draggable', 'false');
    expect(img).toHaveAttribute('src', 'data:image/svg+xml;base64,AAA');
  });
});
