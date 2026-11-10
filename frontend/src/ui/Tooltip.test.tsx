import { afterEach, describe, it, expect, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Tooltip } from './Tooltip';

function Wrapped({ disabled }: { disabled?: boolean }): React.ReactElement {
  return (
    <Tooltip content="Explains it" disabled={disabled}>
      <button type="button">Trigger</button>
    </Tooltip>
  );
}

describe('Tooltip', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens on hover and shows its content', async () => {
    render(<Wrapped />);
    await userEvent.hover(screen.getByRole('button', { name: 'Trigger' }));
    expect((await screen.findAllByText('Explains it')).length).toBeGreaterThan(0);
  });

  it('never opens while disabled, and keeps the same trigger element (no remount, focus kept) when enabled again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime, delay: null });
    const { rerender } = render(<Wrapped disabled />);
    const trigger = screen.getByRole('button', { name: 'Trigger' });
    trigger.focus();
    await user.hover(trigger);
    act(() => {
      vi.advanceTimersByTime(500); // well past the 200ms hover delay
    });
    expect(screen.queryByText('Explains it')).toBeNull();

    rerender(<Wrapped />);
    expect(screen.getByRole('button', { name: 'Trigger' })).toBe(trigger);
    expect(trigger).toHaveFocus();
  });

  it('does not come back stuck open when it is enabled after a hover (and a leave) that happened while it was disabled', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime, delay: null });
    const { rerender } = render(<Wrapped disabled />);
    const trigger = screen.getByRole('button', { name: 'Trigger' });
    await user.hover(trigger);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    await user.unhover(trigger);
    act(() => {
      vi.advanceTimersByTime(500);
    });

    rerender(<Wrapped />);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(screen.queryByText('Explains it')).toBeNull();
  });

  it('closes an open tooltip when it becomes disabled, and does not reopen it when enabled again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime, delay: null });
    const { rerender } = render(<Wrapped />);
    const trigger = screen.getByRole('button', { name: 'Trigger' });
    await user.hover(trigger);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(screen.queryAllByText('Explains it').length).toBeGreaterThan(0);

    rerender(<Wrapped disabled />);
    expect(screen.queryByText('Explains it')).toBeNull();
    await user.unhover(trigger);
    rerender(<Wrapped />);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(screen.queryByText('Explains it')).toBeNull();
  });
});
