import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PhaseSummary } from './PhaseSummary';

describe('PhaseSummary', () => {
  it('records what a finished phase produced, and never shows a time estimate', () => {
    render(
      <PhaseSummary label="Parse" state="done" purpose="Reading the document." produced="12 blocks · 39 figures described" onBackToLive={() => {}} />,
    );
    expect(screen.getByRole('heading', { name: 'Parse' })).toBeInTheDocument();
    expect(screen.getByText('Finished')).toBeInTheDocument();
    expect(screen.getByText('12 blocks · 39 figures described')).toBeInTheDocument();
    expect(screen.queryByText(/typically|left|min\b/i)).not.toBeInTheDocument();
  });

  it('says what a pending phase is for, and that it has not started', () => {
    render(<PhaseSummary label="Score" state="pending" purpose="Judging each drafted requirement." produced={null} onBackToLive={() => {}} />);
    expect(screen.getByText('Not started yet')).toBeInTheDocument();
    expect(screen.getByText('Judging each drafted requirement.')).toBeInTheDocument();
  });

  it('names a failed phase as failed', () => {
    render(<PhaseSummary label="Analyze" state="failed" purpose="x" produced={null} onBackToLive={() => {}} />);
    expect(screen.getByText('Failed here')).toBeInTheDocument();
  });

  it('offers Back to live and shows the phase\'s own content', async () => {
    const onBackToLive = vi.fn();
    render(
      <PhaseSummary label="Parse" state="done" purpose="x" produced={null} onBackToLive={onBackToLive}>
        <p>figure list</p>
      </PhaseSummary>,
    );
    expect(screen.getByText('figure list')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Back to live' }));
    expect(onBackToLive).toHaveBeenCalledTimes(1);
  });
});
