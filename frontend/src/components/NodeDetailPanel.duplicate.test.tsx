import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NodeDetailPanel } from './NodeDetailPanel';

const entry = { localId: 'n1', parentLocalId: null, type: 'Requirement', title: 'T', description: 'd', action: 'dedup_skip', existingAdoId: 123, similarity: 0.93, customerId: null } as never;

describe('NodeDetailPanel duplicate slot', () => {
  it('shows what the caller puts there, beside the other controls under the title', () => {
    render(<NodeDetailPanel entry={entry} jobStatus="diff_ready" duplicateSlot={<div>match card</div>} />);

    expect(screen.getByText('match card')).toBeInTheDocument();
  });

  it('shows nothing extra when the caller has none', () => {
    render(<NodeDetailPanel entry={entry} jobStatus="diff_ready" />);

    expect(screen.queryByText('match card')).toBeNull();
  });
});
