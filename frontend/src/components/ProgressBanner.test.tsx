import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ProgressBanner } from './ProgressBanner';

describe('ProgressBanner', () => {
  it.each([
    ['parse', /parsing/i],
    ['infer_hierarchy_start', /analyzing structure/i],
    ['generate_requirements_done', /finalizing/i],
  ])('renders a human label for stage %s', (stage, expectedText) => {
    render(<ProgressBanner stage={stage as any} startedAt="2026-07-09T10:00:00Z" mode="survey" />);
    expect(screen.getByText(expectedText)).toBeInTheDocument();
  });

  it('shows the ~40 min messaging for survey jobs', () => {
    render(<ProgressBanner stage="parse" startedAt="2026-07-09T10:00:00Z" mode="survey" />);
    expect(screen.getByText(/up to ~40 min/i)).toBeInTheDocument();
  });
});
