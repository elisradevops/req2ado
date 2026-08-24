import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ActionBadge } from './ActionBadge';

describe('ActionBadge', () => {
  it('renders a plain, non-linked chip when no orgUrl is available', () => {
    render(<ActionBadge action="dedup_skip" existingAdoId={509} />);
    expect(screen.getByText('Near-duplicate of WI-509')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('links a dedup_skip badge to the real matched item in Azure DevOps', () => {
    render(<ActionBadge action="dedup_skip" existingAdoId={509} orgUrl="https://dev.azure.com/example-org" />);
    const link = screen.getByRole('link', { name: /near-duplicate of wi-509/i });
    expect(link).toHaveAttribute('href', 'https://dev.azure.com/example-org/_workitems/edit/509');
    expect(link).toHaveAttribute('target', '_blank');
    // Real bug (user-reported): <a href> is natively draggable in every
    // browser regardless of any ancestor's own `draggable` attribute --
    // inside DiffTree's draggable rows (DESIGN.md §11.5), grabbing a row
    // on top of this link triggered the browser's own link-drag instead
    // of the row's custom row-move drag.
    expect(link).toHaveAttribute('draggable', 'false');
  });

  it('links a reuse badge to the real matched item in Azure DevOps', () => {
    render(<ActionBadge action="reuse" existingAdoId={604} orgUrl="https://dev.azure.com/example-org" />);
    const link = screen.getByRole('link', { name: /links to wi-604/i });
    expect(link).toHaveAttribute('href', 'https://dev.azure.com/example-org/_workitems/edit/604');
    expect(link).toHaveAttribute('draggable', 'false');
  });

  it('never links a create badge -- there is no ADO item yet to open', () => {
    render(<ActionBadge action="create" orgUrl="https://dev.azure.com/example-org" />);
    expect(screen.getByText('New')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('includes the project segment in the link when project is provided -- avoids ADO resolving the id against the wrong project context', () => {
    render(<ActionBadge action="dedup_skip" existingAdoId={532} orgUrl="https://dev.azure.com/example-org" project="elisradevops-project" />);
    const link = screen.getByRole('link', { name: /near-duplicate of wi-532/i });
    expect(link).toHaveAttribute('href', 'https://dev.azure.com/example-org/elisradevops-project/_workitems/edit/532');
  });
});
