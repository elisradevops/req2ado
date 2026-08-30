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

  it('renders 00:00 (never a literal "NaN:NaN") for an unparseable startedAt', () => {
    // Real gap this closes: new Date(startedAt).getTime() on an
    // unparseable string is NaN, which previously passed straight through
    // Math.floor/toString/padStart into the literal string "NaN:NaN".
    render(<ElapsedTimer startedAt="not-a-real-date" />);
    expect(screen.getByText('00:00')).toBeInTheDocument();
  });
});
