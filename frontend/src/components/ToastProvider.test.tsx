import { useRef } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider, useToast } from './ToastProvider';

function TriggerButton({ message, severity }: { message: string; severity: 'error' | 'info' | 'success' | 'warning' }): React.ReactElement {
  const { showToast } = useToast();
  return (
    <button type="button" onClick={() => showToast(message, severity)}>
      Trigger
    </button>
  );
}

// DESIGN.md §5's geometry table: "Feedback | Alert / Toast: radius md. Left
// accent bar 4px in the severity's fill colour." Previously every toast
// severity rendered visually identical except for the small icon color --
// this locks in the left accent bar distinguishing them.
describe('ToastProvider', () => {
  it('gives each severity its own left accent bar color, not just the icon', async () => {
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <TriggerButton message="Failed to save" severity="error" />
      </ToastProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'Trigger' }));
    const toast = await screen.findByText('Failed to save');
    expect(toast.closest('[class*="border-l-4"]')).toHaveClass('border-l-danger');
  });

  it('uses a distinct border color per severity', async () => {
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <TriggerButton message="Saved" severity="success" />
      </ToastProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'Trigger' }));
    const toast = await screen.findByText('Saved');
    expect(toast.closest('[class*="border-l-4"]')).toHaveClass('border-l-ok');
  });

  it('keeps the context value referentially stable across a toast add, so consumers do not re-render for no reason', async () => {
    const seenValues: unknown[] = [];
    function Consumer(): React.ReactElement {
      const value = useToast();
      const renderCount = useRef(0);
      renderCount.current += 1;
      seenValues.push(value);
      return (
        <button type="button" onClick={() => value.showToast('hi', 'info')}>
          Trigger {renderCount.current}
        </button>
      );
    }
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <Consumer />
      </ToastProvider>,
    );
    const before = seenValues.at(-1);

    await user.click(screen.getByRole('button', { name: /Trigger/ }));
    await screen.findByText('hi');

    const after = seenValues.at(-1);
    expect(after).toBe(before);
  });

  it('renders an action button that runs its handler once and dismisses the toast', async () => {
    const onAction = vi.fn();
    function Trigger(): React.ReactElement {
      const { showToast } = useToast();
      return (
        <button type="button" onClick={() => showToast('2 items marked reviewed.', 'success', { label: 'Undo', onAction })}>
          Trigger
        </button>
      );
    }
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <Trigger />
      </ToastProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'Trigger' }));
    await screen.findByText('2 items marked reviewed.');

    await user.click(screen.getByRole('button', { name: 'Undo' }));

    expect(onAction).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(screen.queryByText('2 items marked reviewed.')).not.toBeInTheDocument());
  });

  it('keeps at most three toasts on screen, dropping the oldest', async () => {
    function Trigger(): React.ReactElement {
      const { showToast } = useToast();
      return (
        <button type="button" onClick={() => ['one', 'two', 'three', 'four'].forEach((m) => showToast(m, 'info'))}>
          Trigger
        </button>
      );
    }
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <Trigger />
      </ToastProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'Trigger' }));

    await screen.findByText('four');
    expect(screen.queryByText('one')).not.toBeInTheDocument();
    expect(screen.getByText('two')).toBeInTheDocument();
  });

  it('an error toast offers Details, which opens the error dialog with the message and status', async () => {
    const user = userEvent.setup();
    function ErrorTrigger(): React.ReactElement {
      const { showErrorToast } = useToast();
      return (
        <button
          type="button"
          onClick={() => showErrorToast('Failed to rescore', { message: 'No usable score', status: 502, timestamp: 't' })}
        >
          Fail
        </button>
      );
    }
    render(
      <ToastProvider>
        <ErrorTrigger />
      </ToastProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'Fail' }));
    await user.click(await screen.findByRole('button', { name: /Details/ }));
    expect(await screen.findByText('Error details')).toBeInTheDocument();
    expect(screen.getByText('No usable score')).toBeInTheDocument();
    expect(screen.getByText('502')).toBeInTheDocument();
  });
});
