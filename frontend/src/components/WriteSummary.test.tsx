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
  alreadyWritten: 0,
};
const review = { edited: 0, single: 3, bulk: 0, bulkSpotChecked: 0, group: 0, earlier: 0, notReviewed: 0 };
const props = {
  teamProject: 'Compliance',
  areaPath: 'Compliance\\Auth',
  warnings: { open: { fix: 0, review: 0, info: 0 }, handled: 0 },
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
    render(<WriteSummary {...props} state={{ status: 'ready', preview: { ...preview, createdTotal: 0, createdLocalIds: [], createdByType: {}, parentLinks: 0 }, review }} />);
    expect(screen.getByRole('status')).toHaveTextContent('Ready: nothing will be created, so there is nothing to write.');
  });

  it('announces a retry with only links left as work to finish', () => {
    const retry = { ...preview, createdTotal: 0, createdLocalIds: [], createdByType: {}, parentLinks: 3, alreadyWritten: 4 };
    render(<WriteSummary {...props} state={{ status: 'ready', preview: retry, review }} />);
    expect(screen.getByRole('status')).toHaveTextContent('Ready: nothing new to create; 3 parent links remain.');
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

  describe('shortcut actions', () => {
    const ready = { status: 'ready' as const, preview: { ...preview, excluded: { direct: 0, viaAncestor: 0 } }, review };
    const warn = (fix: number) => ({ open: { fix, review: 0, info: 0 }, handled: 0 });

    it('shows no actions section when nothing applies', () => {
      render(<WriteSummary {...props} state={ready} onReviewUnreviewed={() => {}} onShowWarnings={() => {}} onShowExcluded={() => {}} />);
      expect(screen.queryByText('Before you write:')).toBeNull();
    });

    it('shows no button without its callback, even when the count is above zero', () => {
      render(<WriteSummary {...props} warnings={warn(2)} state={{ ...ready, review: { ...review, notReviewed: 2 } }} />);
      expect(screen.queryByText('Before you write:')).toBeNull();
    });

    it('offers to review unreviewed items, singular and plural, and calls back', async () => {
      const onReviewUnreviewed = vi.fn();
      const { rerender } = render(<WriteSummary {...props} onReviewUnreviewed={onReviewUnreviewed} state={{ ...ready, review: { ...review, notReviewed: 1 } }} />);
      expect(screen.getByText('Before you write:')).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'Review 1 unreviewed item' }));
      expect(onReviewUnreviewed).toHaveBeenCalledTimes(1);
      rerender(<WriteSummary {...props} onReviewUnreviewed={onReviewUnreviewed} state={{ ...ready, review: { ...review, notReviewed: 4 } }} />);
      expect(screen.getByRole('button', { name: 'Review 4 unreviewed items' })).toBeInTheDocument();
    });

    it('does not offer the review button while loading', () => {
      render(<WriteSummary {...props} onReviewUnreviewed={() => {}} state={{ status: 'loading' }} />);
      expect(screen.queryByRole('button', { name: /unreviewed/i })).toBeNull();
    });

    it('offers to go to warnings to fix, singular and plural, and calls back', async () => {
      const onShowWarnings = vi.fn();
      const { rerender } = render(<WriteSummary {...props} warnings={warn(1)} onShowWarnings={onShowWarnings} state={ready} />);
      await userEvent.click(screen.getByRole('button', { name: 'Go to 1 warning to fix' }));
      expect(onShowWarnings).toHaveBeenCalledTimes(1);
      rerender(<WriteSummary {...props} warnings={warn(3)} onShowWarnings={onShowWarnings} state={ready} />);
      expect(screen.getByRole('button', { name: 'Go to 3 warnings to fix' })).toBeInTheDocument();
    });

    it('offers to show excluded items (direct plus under an excluded parent), and calls back', async () => {
      const onShowExcluded = vi.fn();
      const state = { ...ready, preview: { ...preview, excluded: { direct: 1, viaAncestor: 2 } } };
      render(<WriteSummary {...props} onShowExcluded={onShowExcluded} state={state} />);
      await userEvent.click(screen.getByRole('button', { name: 'Show the 3 excluded items' }));
      expect(onShowExcluded).toHaveBeenCalledTimes(1);
    });

    it('says "Show the 1 excluded item" for one', () => {
      render(<WriteSummary {...props} onShowExcluded={() => {}} state={{ ...ready, preview: { ...preview, excluded: { direct: 1, viaAncestor: 0 } } }} />);
      expect(screen.getByRole('button', { name: 'Show the 1 excluded item' })).toBeInTheDocument();
    });

    it('draws the actions as outlined buttons', () => {
      render(<WriteSummary {...props} warnings={warn(1)} onShowWarnings={() => {}} state={ready} />);
      // class pin: jsdom has no layout
      expect(screen.getByRole('button', { name: /warning to fix/i }).className).toContain('border-field-border');
    });
  });

  it('no longer has a back-to-the-tree link', () => {
    render(<WriteSummary {...props} state={{ status: 'ready', preview, review }} />);
    expect(screen.queryByRole('button', { name: 'Back to the tree' })).toBeNull();
  });
});
