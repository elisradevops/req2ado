import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { KbSwitchLibraryDialog } from './KbSwitchLibraryDialog';

function renderDialog(props: Partial<React.ComponentProps<typeof KbSwitchLibraryDialog>> = {}) {
  const handlers = { onOpenChange: vi.fn(), onConfirm: vi.fn() };
  render(<KbSwitchLibraryDialog open otherDrive={3} unknownDrive={0} {...handlers} {...props} />);
  return handlers;
}

describe('KbSwitchLibraryDialog', () => {
  it('says what will be removed and why, before anything is', () => {
    renderDialog();

    expect(screen.getByRole('dialog', { name: /switch to this library/i })).toBeInTheDocument();
    expect(screen.getByText(/holds 3 files from a different sharepoint library/i)).toBeInTheDocument();
    expect(screen.getByText(/keeps one library/i)).toBeInTheDocument();
  });

  it('names the number of files on the confirm button', () => {
    renderDialog({ otherDrive: 1 });

    expect(screen.getByRole('button', { name: /^remove 1 file and continue$/i })).toBeInTheDocument();
  });

  it('counts the files whose library is unknown too, and explains them separately', () => {
    renderDialog({ otherDrive: 2, unknownDrive: 4 });

    expect(screen.getByRole('button', { name: /^remove 6 files and continue$/i })).toBeInTheDocument();
    expect(screen.getByText(/4 files were added before the library was tracked/i)).toBeInTheDocument();
  });

  it('with only unknown files, does not claim they came from a different library', () => {
    renderDialog({ otherDrive: 0, unknownDrive: 2 });

    expect(screen.queryByText(/from a different sharepoint library/i)).toBeNull();
    expect(screen.getByText(/2 files were added before the library was tracked/i)).toBeInTheDocument();
  });

  it('confirms and cancels', async () => {
    const { onConfirm, onOpenChange } = renderDialog();

    await userEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onConfirm).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: /remove 3 files and continue/i }));
    expect(onConfirm).toHaveBeenCalled();
  });

  it('cannot be confirmed twice while the removal runs', () => {
    renderDialog({ isWorking: true });

    expect(screen.getByRole('button', { name: /remove 3 files and continue/i })).toBeDisabled();
  });

  it('says a failed removal in words, and keeps the dialog usable to try again', () => {
    renderDialog({ errorMessage: 'Could not remove 1 file (a.pdf). Try again.' });

    expect(screen.getByText(/could not remove 1 file \(a\.pdf\)/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /remove 3 files and continue/i })).toBeEnabled();
  });
});
