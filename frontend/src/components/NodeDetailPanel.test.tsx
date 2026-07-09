import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NodeDetailPanel } from './NodeDetailPanel';

describe('NodeDetailPanel', () => {
  it('renders a placeholder when nothing is selected', () => {
    render(<NodeDetailPanel entry={null} />);
    expect(screen.getByText(/select a node/i)).toBeInTheDocument();
  });

  it('renders the entry title, description, type, and tags when selected', () => {
    render(
      <NodeDetailPanel
        entry={{ localId: 'e1', parentLocalId: null, type: 'Requirement', title: 'Req Title', description: 'Req body', action: 'CREATE', customerId: null, tags: ['functional'] }}
      />,
    );
    expect(screen.getByText('Req Title')).toBeInTheDocument();
    expect(screen.getByText('Req body')).toBeInTheDocument();
    expect(screen.getByText('functional')).toBeInTheDocument();
  });
});
