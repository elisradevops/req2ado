import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { WritePreview } from '../api/jobs';
import { WriteSummary } from './WriteSummary';

const preview: WritePreview = {
  createdTotal: 3,
  createdLocalIds: ['a', 'b', 'c'],
  createdByType: { Feature: 1, Requirement: 2 },
  excluded: { direct: 1, viaAncestor: 0 },
  parentLinks: 2,
  existingGettingChildren: 0,
  existingWithoutNewParentLink: 0,
  traceLinks: { planned: 0, skipped: 0 },
};
const review = { edited: 0, single: 3, bulk: 0, bulkSpotChecked: 0, earlier: 0, notReviewed: 0 };
const props = {
  teamProject: 'Compliance',
  areaPath: 'Compliance\\Auth',
  warnings: { open: { fix: 0, review: 0, info: 0 }, handled: 0 },
  onBackToTree: () => {},
};

describe('WriteSummary', () => {
  it('says it is checking while the preview loads', () => {
    render(<WriteSummary {...props} state={{ status: 'loading' }} />);
    expect(screen.getByRole('status')).toHaveTextContent('Checking what will be written');
  });

  it('says it could not check, and does not block the write', () => {
    render(<WriteSummary {...props} state={{ status: 'error' }} />);
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't check what will be written");
  });

  it('announces the outcome from the same status region once the preview is ready', () => {
    const { rerender } = render(<WriteSummary {...props} state={{ status: 'loading' }} />);
    const region = screen.getByRole('status');
    rerender(<WriteSummary {...props} state={{ status: 'ready', preview, review }} />);
    expect(screen.getByRole('status')).toBe(region);
    expect(region).toHaveTextContent('Ready: 3 items will be created.');
  });

  it('announces a write of zero items as nothing to write', () => {
    render(<WriteSummary {...props} state={{ status: 'ready', preview: { ...preview, createdTotal: 0, createdLocalIds: [], createdByType: {} }, review }} />);
    expect(screen.getByRole('status')).toHaveTextContent('Ready: nothing will be created, so there is nothing to write.');
  });

  it('says only what it can stand behind when the check fails', () => {
    render(<WriteSummary {...props} state={{ status: 'error' }} />);
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't check what will be written. You can still write.");
    expect(screen.getByRole('alert')).not.toHaveTextContent('count above');
  });

  it('shows the destination and the summary lines', () => {
    render(<WriteSummary {...props} state={{ status: 'ready', preview, review }} />);
    expect(screen.getByText('Compliance\\Auth')).toBeInTheDocument();
    expect(screen.getByText('3 new work items: 1 Feature, 2 Requirements.')).toBeInTheDocument();
    expect(screen.getByText('1 item left out: 1 excluded by you.')).toBeInTheDocument();
    expect(screen.getByText('Review: 3 approved one by one.')).toBeInTheDocument();
  });

  it('warns when blocking or review warnings are still open', () => {
    render(<WriteSummary {...props} warnings={{ open: { fix: 2, review: 1, info: 4 }, handled: 3 }} state={{ status: 'ready', preview, review }} />);
    expect(screen.getByText(/2 warnings to fix and 1 to check are still open\. You can still write\./)).toBeInTheDocument();
    expect(screen.getByText(/3 marked handled/)).toBeInTheDocument();
  });

  it('offers a way back to the tree', async () => {
    const onBackToTree = vi.fn();
    render(<WriteSummary {...props} onBackToTree={onBackToTree} state={{ status: 'ready', preview, review }} />);
    await userEvent.click(screen.getByRole('button', { name: 'Back to the tree' }));
    expect(onBackToTree).toHaveBeenCalled();
  });
});
