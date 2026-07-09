import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { ElapsedTimer } from './ElapsedTimer';

describe('ElapsedTimer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-09T10:00:05Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders elapsed mm:ss since startedAt and ticks forward', () => {
    render(<ElapsedTimer startedAt="2026-07-09T10:00:00Z" />);
    expect(screen.getByText('00:05')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.getByText('00:10')).toBeInTheDocument();
  });
});
