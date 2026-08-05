import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NarrationTicker } from './NarrationTicker';

describe('NarrationTicker', () => {
  it('renders the sentence on the left', () => {
    render(<NarrationTicker sentence="Analyzing and synthesizing requirements" isLive startedAt="2026-07-09T10:00:00Z" />);
    expect(screen.getByText('Analyzing and synthesizing requirements')).toBeInTheDocument();
  });

  it('shows a ticking Elapsed clock when live', () => {
    render(<NarrationTicker sentence="Working" isLive startedAt="2026-07-09T10:00:00Z" />);
    expect(screen.getByText(/Elapsed:/)).toBeInTheDocument();
  });

  it('omits the elapsed clock entirely when not live, rather than showing a misleading duration', () => {
    render(<NarrationTicker sentence="Wrote the reviewed work items to Azure DevOps." isLive={false} startedAt="2026-07-09T10:00:00Z" />);
    expect(screen.queryByText(/Elapsed:/)).not.toBeInTheDocument();
  });

  it('never renders an empty bar', () => {
    render(<NarrationTicker sentence="Queued — waiting for a pipeline worker to pick this job up." isLive startedAt="2026-07-09T10:00:00Z" />);
    expect(screen.getByText(/Queued/)).toBeInTheDocument();
  });
});
