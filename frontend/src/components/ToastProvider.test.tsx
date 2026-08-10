import { describe, it, expect } from 'vitest';
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
});
