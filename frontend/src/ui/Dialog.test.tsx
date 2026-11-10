// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { useRef, useState } from 'react';
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
    const focusSpy = vi.spyOn(opener, 'focus');
    await user.click(opener);
    await screen.findByRole('dialog');
    focusSpy.mockClear(); // the click itself focuses the opener
    // The opener unmounts while the dialog is open (e.g. its row was removed).
    // Radix hides the page behind the modal, so dispatch the click directly.
    fireEvent.click(screen.getByRole('button', { name: 'Remove opener', hidden: true }));
    await waitFor(() => expect(opener.isConnected).toBe(false));
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(focusSpy).not.toHaveBeenCalled();
    expect(document.activeElement?.isConnected).toBe(true);
  });
});

function RefHarness({
  mode,
  restoreFocus,
  detached,
}: {
  mode: 'connected' | 'empty' | 'disconnected';
  restoreFocus?: boolean;
  detached?: React.RefObject<HTMLElement | null>;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const targetRef = useRef<HTMLButtonElement>(null);
  const emptyRef = useRef<HTMLButtonElement>(null);
  const ref = mode === 'empty' ? emptyRef : mode === 'disconnected' ? detached! : targetRef;
  return (
    <>
      <button onClick={() => setOpen(true)}>Open it</button>
      <button ref={targetRef}>Target</button>
      <Dialog open={open} onOpenChange={setOpen} title="Plain" returnFocusRef={ref} restoreFocus={restoreFocus}>
        <button>Inside</button>
      </Dialog>
    </>
  );
}

describe('Dialog returnFocusRef / restoreFocus', () => {
  it('returnFocusRef wins over the opener when its element is connected', async () => {
    const user = userEvent.setup();
    render(<RefHarness mode="connected" />);
    await user.click(screen.getByRole('button', { name: 'Open it' }));
    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Target' })));
  });

  it('falls back to the opener when the ref is empty', async () => {
    const user = userEvent.setup();
    render(<RefHarness mode="empty" />);
    const opener = screen.getByRole('button', { name: 'Open it' });
    await user.click(opener);
    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it('falls back to the opener when the ref element is disconnected', async () => {
    const user = userEvent.setup();
    // A ref that still points at an element which is no longer in the document.
    const gone = document.createElement('button');
    const targetFocus = vi.spyOn(gone, 'focus');
    render(<RefHarness mode="disconnected" detached={{ current: gone }} />);
    const opener = screen.getByRole('button', { name: 'Open it' });
    await user.click(opener);
    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(document.activeElement).toBe(opener));
    expect(targetFocus).not.toHaveBeenCalled();
  });

  it('restoreFocus={false} moves no focus on close', async () => {
    const user = userEvent.setup();
    render(<RefHarness mode="connected" restoreFocus={false} />);
    const opener = screen.getByRole('button', { name: 'Open it' });
    const openerFocus = vi.spyOn(opener, 'focus');
    const target = screen.getByRole('button', { name: 'Target' });
    const targetFocus = vi.spyOn(target, 'focus');
    await user.click(opener);
    await screen.findByRole('dialog');
    openerFocus.mockClear(); // the click itself focuses the opener
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(openerFocus).not.toHaveBeenCalled();
    expect(targetFocus).not.toHaveBeenCalled();
  });
});

describe('Dialog body', () => {
  it('pads the top of the scrolling body so the first child focus ring is not clipped', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Open it' }));
    await screen.findByRole('dialog');
    // class pin: jsdom has no layout, so it cannot measure the clipping itself.
    expect(screen.getByRole('button', { name: 'Inside' }).parentElement?.className).toContain('pt-1');
  });
});
