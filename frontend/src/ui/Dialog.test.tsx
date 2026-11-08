// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Dialog } from './Dialog';
import { ConfirmDialog } from './ConfirmDialog';

function Harness({ confirm = false }: { confirm?: boolean }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [showOpener, setShowOpener] = useState(true);
  return (
    <>
      {showOpener && <button onClick={() => setOpen(true)}>Open it</button>}
      <button onClick={() => setShowOpener(false)}>Remove opener</button>
      {confirm ? (
        <ConfirmDialog open={open} onOpenChange={setOpen} title="Sure?" confirmLabel="Yes" onConfirm={() => setOpen(false)} />
      ) : (
        <Dialog open={open} onOpenChange={setOpen} title="Plain">
          <button>Inside</button>
        </Dialog>
      )}
    </>
  );
}

describe.each([
  ['Dialog', false],
  ['ConfirmDialog', true],
])('%s focus return', (_name, confirm) => {
  it('returns focus to the element that opened it on Escape', async () => {
    const user = userEvent.setup();
    render(<Harness confirm={confirm} />);
    const opener = screen.getByRole('button', { name: 'Open it' });
    await user.click(opener);
    expect(await screen.findByRole('dialog')).toBeTruthy();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it('returns focus to the opener after the Close button', async () => {
    const user = userEvent.setup();
    render(<Harness confirm={confirm} />);
    const opener = screen.getByRole('button', { name: 'Open it' });
    await user.click(opener);
    await user.click(await screen.findByRole('button', { name: 'Close' }));
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });
});

describe('Dialog focus return, opener gone', () => {
  it('does not focus a removed opener', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'Open it' });
    await user.click(opener);
    await screen.findByRole('dialog');
    // The opener unmounts while the dialog is open (e.g. its row was removed).
    // Radix hides the page behind the modal, so dispatch the click directly.
    fireEvent.click(screen.getByRole('button', { name: 'Remove opener', hidden: true }));
    await waitFor(() => expect(opener.isConnected).toBe(false));
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).not.toBe(opener);
    expect(document.activeElement?.isConnected).toBe(true);
  });
});
