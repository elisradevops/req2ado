import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConfirmDialog } from './ConfirmDialog';

function confirmButton(): HTMLElement {
  return screen.getByRole('button', { name: /^go$/i });
}

// Exact-token membership, not substring -- `cta-attention` is itself a
// substring of the variant's own always-present `hover:shadow-cta-attention`
// class, so a naive `.className.includes('cta-attention')` false-positives
// on every `cta` button regardless of whether the breathing class was
// actually applied.
function confirmButton2(): HTMLElement {
  return screen.getByRole('button', { name: /^write 164 items/i });
}

function hasClass(el: HTMLElement, token: string): boolean {
  return el.className.split(/\s+/).includes(token);
}

describe('ConfirmDialog footer', () => {
  it('wraps, with the acknowledgement on its own row, so a long confirm label cannot squeeze it or overflow the dialog', () => {
    render(<ConfirmDialog open onOpenChange={() => {}} title="t" confirmLabel="Write 164 items to a-long-project-name" onConfirm={() => {}} variant="irreversible" />);
    const footer = confirmButton2().parentElement as HTMLElement;
    expect(hasClass(footer, 'flex-wrap')).toBe(true);
    expect(hasClass(screen.getByRole('checkbox').closest('label') as HTMLElement, 'w-full')).toBe(true);
  });
});

describe('ConfirmDialog irreversible focus and long labels', () => {
  it('puts initial focus on Cancel, not on content inside the dialog', async () => {
    render(
      <ConfirmDialog open onOpenChange={() => {}} title="t" confirmLabel="Go" onConfirm={() => {}} variant="irreversible">
        <button type="button">Back</button>
      </ConfirmDialog>,
    );
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus());
  });

  it('keeps the full label as the accessible name while letting it truncate visually', () => {
    render(<ConfirmDialog open onOpenChange={() => {}} title="t" confirmLabel="Write 164 items to a-very-long-project-name" onConfirm={() => {}} />);
    const button = screen.getByRole('button', { name: 'Write 164 items to a-very-long-project-name' });
    expect(hasClass(button, 'max-w-full')).toBe(true);
    expect(hasClass(button.querySelector('span') as HTMLElement, 'truncate')).toBe(true);
  });
});

describe('ConfirmDialog on a short screen', () => {
  it('limits its height to the screen so the body scrolls and the buttons stay reachable', () => {
    render(<ConfirmDialog open onOpenChange={() => {}} title="t" confirmLabel="Go" onConfirm={() => {}} description="d"><p>body</p></ConfirmDialog>);
    expect(screen.getByRole('dialog').className).toContain('max-h-[calc(100dvh-2rem)]');
    expect(hasClass(screen.getByText('body').parentElement as HTMLElement, 'overflow-y-auto')).toBe(true);
  });
});

describe('ConfirmDialog confirmDisabled', () => {
  it('describes why the confirm button is disabled', () => {
    render(<ConfirmDialog open onOpenChange={() => {}} title="t" confirmLabel="Go" onConfirm={() => {}} confirmDisabled confirmDisabledReason="Nothing to write." />);
    expect(confirmButton()).toHaveAccessibleDescription('Nothing to write.');
  });

  it('keeps the confirm button disabled when the caller says the action would do nothing', () => {
    render(<ConfirmDialog open onOpenChange={() => {}} title="t" confirmLabel="Go" onConfirm={() => {}} confirmDisabled />);
    expect(confirmButton()).toBeDisabled();
  });
});

describe('ConfirmDialog variants', () => {
  it('defaults to neutral (primary, ink-black) when no variant is given', () => {
    render(<ConfirmDialog open onOpenChange={() => {}} title="t" confirmLabel="Go" onConfirm={() => {}} />);
    // DESIGN.md §15.7: signal-yellow (the `cta` Button variant) is banned
    // outside the irreversible confirm-to-ADO CTA -- a caller that forgets
    // to specify a variant must NOT silently fall through to it (the real
    // bug this rebuild fixes: three "Resubmit" dialogs used to do exactly
    // this).
    expect(confirmButton().className).not.toContain('bg-signal');
    expect(confirmButton().className).toContain('bg-action');
  });

  it('neutral never shows the acknowledgement checkbox or breathing state', () => {
    render(<ConfirmDialog open onOpenChange={() => {}} title="t" confirmLabel="Go" onConfirm={() => {}} variant="neutral" />);
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(confirmButton()).not.toBeDisabled();
  });

  it('destructive uses the danger button and wraps its description in a tinted consequence callout', () => {
    render(
      <ConfirmDialog
        open
        onOpenChange={() => {}}
        title="Delete?"
        description="This permanently removes the job."
        confirmLabel="Go"
        onConfirm={() => {}}
        variant="destructive"
      />,
    );
    expect(confirmButton().className).toContain('bg-surface');
    expect(confirmButton().className).toContain('text-danger');
    const description = screen.getByText('This permanently removes the job.');
    expect(description.closest('.bg-danger-soft')).not.toBeNull();
  });

  it('does not render an empty padded body when destructive has no description and no children', () => {
    const { container } = render(
      <ConfirmDialog open onOpenChange={() => {}} title="Delete?" confirmLabel="Go" onConfirm={() => {}} variant="destructive" />,
    );
    // The Dialog body wrapper (`flex flex-col gap-3 px-5 pb-1`) must not
    // exist at all when there is nothing to put inside it.
    expect(container.querySelector('.px-5.pb-1')).toBeNull();
  });

  it('irreversible disables Confirm until the acknowledgement checkbox is ticked, then breathes', async () => {
    render(
      <ConfirmDialog open onOpenChange={() => {}} title="Write?" confirmLabel="Go" onConfirm={() => {}} variant="irreversible" />,
    );
    expect(confirmButton()).toBeDisabled();
    expect(hasClass(confirmButton(), 'cta-attention')).toBe(false);

    await userEvent.click(screen.getByRole('checkbox'));

    expect(confirmButton()).not.toBeDisabled();
    expect(confirmButton().className).toContain('bg-signal');
    expect(hasClass(confirmButton(), 'cta-attention')).toBe(true);
  });

  it('resets the acknowledgement checkbox every time the dialog reopens', async () => {
    const { rerender } = render(
      <ConfirmDialog open onOpenChange={() => {}} title="Write?" confirmLabel="Go" onConfirm={() => {}} variant="irreversible" />,
    );
    await userEvent.click(screen.getByRole('checkbox'));
    expect(confirmButton()).not.toBeDisabled();

    rerender(<ConfirmDialog open={false} onOpenChange={() => {}} title="Write?" confirmLabel="Go" onConfirm={() => {}} variant="irreversible" />);
    rerender(<ConfirmDialog open onOpenChange={() => {}} title="Write?" confirmLabel="Go" onConfirm={() => {}} variant="irreversible" />);

    expect(screen.getByRole('checkbox')).not.toBeChecked();
    expect(confirmButton()).toBeDisabled();
  });

  it('calls onConfirm when Confirm is clicked (neutral)', async () => {
    const onConfirm = vi.fn();
    render(<ConfirmDialog open onOpenChange={() => {}} title="t" confirmLabel="Go" onConfirm={onConfirm} />);
    await userEvent.click(confirmButton());
    expect(onConfirm).toHaveBeenCalled();
  });

  it('disables Confirm and shows a spinner while isConfirming', () => {
    render(<ConfirmDialog open onOpenChange={() => {}} title="t" confirmLabel="Go" onConfirm={() => {}} isConfirming />);
    expect(confirmButton()).toBeDisabled();
    expect(confirmButton()).toHaveAttribute('aria-busy', 'true');
  });
});
