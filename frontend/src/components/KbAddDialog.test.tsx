import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { KbAddDialog } from './KbAddDialog';
import type { KbRetrievalMode } from '../api/kb';

const MB = 1024 * 1024;

function renderDialog(overrides: Partial<React.ComponentProps<typeof KbAddDialog>> = {}) {
  const onConfirm = vi.fn();
  const onOpenChange = vi.fn();
  render(
    <KbAddDialog
      open
      onOpenChange={onOpenChange}
      file={{ name: 'Customer_SRS.docx', sizeBytes: 200 * 1024 }}
      currentMode={null}
      rememberedMode={null}
      onConfirm={onConfirm}
      {...overrides}
    />,
  );
  return { onConfirm, onOpenChange };
}

const search = () => screen.getByRole('radio', { name: /^search/i });
const reference = () => screen.getByRole('radio', { name: /^reference/i });
const confirmButton = () => screen.getByRole('button', { name: /^add to knowledge base$/i });

describe('KbAddDialog', () => {
  it('names the file being added', () => {
    renderDialog();

    expect(screen.getByRole('dialog', { name: /add "\s*Customer_SRS\.docx\s*" to the knowledge base/i })).toBeInTheDocument();
  });

  it('explains both ways a file can be used, in plain words', () => {
    renderDialog();

    expect(screen.getByText(/used only when a section of your document is similar to it/i)).toBeInTheDocument();
    expect(screen.getByText(/the full text is added to every survey job/i)).toBeInTheDocument();
    expect(screen.getByText(/every job pays for it in tokens/i)).toBeInTheDocument();
  });

  it('makes the user choose: nothing is selected and Add is disabled until they do', () => {
    renderDialog();

    expect(search()).toHaveAttribute('aria-checked', 'false');
    expect(reference()).toHaveAttribute('aria-checked', 'false');
    expect(confirmButton()).toBeDisabled();
  });

  it('confirms the chosen mode', async () => {
    const { onConfirm } = renderDialog();

    await userEvent.click(search());
    await userEvent.click(confirmButton());

    expect(onConfirm).toHaveBeenCalledWith('retrieve', false);
  });

  it('confirms Reference as always_include', async () => {
    const { onConfirm } = renderDialog();

    await userEvent.click(reference());
    await userEvent.click(confirmButton());

    expect(onConfirm).toHaveBeenCalledWith('always_include', false);
  });

  it('can be driven from the keyboard: arrow keys move between the two choices', async () => {
    renderDialog();

    await userEvent.tab(); // into the dialog, then to the first choice
    search().focus();
    // Radix selects the choice that receives focus while an arrow key is still down, and moves focus on a timeout, so the
    // key is held until it has. (userEvent's plain '{ArrowDown}' releases it instantly, before that timeout fires.)
    await userEvent.keyboard('{ArrowDown>}');
    await waitFor(() => expect(reference()).toHaveAttribute('aria-checked', 'true'));
    await userEvent.keyboard('{/ArrowDown}');
    await userEvent.keyboard('{ArrowUp>}');
    await waitFor(() => expect(search()).toHaveAttribute('aria-checked', 'true'));
    await userEvent.keyboard('{/ArrowUp}');
  });

  it('suggests Reference, with its reason, for a guide-like name, without selecting it', () => {
    renderDialog({ file: { name: 'Requirements_Writing_Standard.pdf', sizeBytes: 300 * 1024 } });

    expect(screen.getByText(/suggested: the name looks like a guide or standard/i)).toBeInTheDocument();
    expect(reference()).toHaveAttribute('aria-checked', 'false');
    expect(confirmButton()).toBeDisabled();
  });

  it('suggests Reference for a Hebrew guide name', () => {
    renderDialog({ file: { name: 'מדריך כתיבת דרישות.docx', sizeBytes: 300 * 1024 } });

    expect(screen.getByText(/suggested:/i)).toBeInTheDocument();
  });

  it('suggests nothing for an ordinary document', () => {
    renderDialog();

    expect(screen.queryByText(/suggested:/i)).toBeNull();
  });

  it('warns that a large Reference file is sent in full with every job', async () => {
    renderDialog({ file: { name: 'Big.pdf', sizeBytes: 6 * MB } });

    expect(screen.queryByText(/this file is large/i)).toBeNull();
    await userEvent.click(reference());

    expect(screen.getByText(/this file is large \(6\.0 MB\)/i)).toBeInTheDocument();
  });

  it('does not warn about a large file when it is added as Search', async () => {
    renderDialog({ file: { name: 'Big.pdf', sizeBytes: 6 * MB } });

    await userEvent.click(search());

    expect(screen.queryByText(/this file is large/i)).toBeNull();
  });

  it('can remember the choice for this folder', async () => {
    const { onConfirm } = renderDialog();

    await userEvent.click(search());
    await userEvent.click(screen.getByRole('checkbox', { name: /remember my choice for this folder/i }));
    await userEvent.click(confirmButton());

    expect(onConfirm).toHaveBeenCalledWith('retrieve', true);
  });

  it('preselects the choice remembered for this folder, and says so', () => {
    renderDialog({ rememberedMode: 'always_include' });

    expect(reference()).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText(/your earlier choice for this folder \(reference\)\. change it above/i)).toBeInTheDocument();
    expect(confirmButton()).toBeEnabled();
  });

  it.each<[KbRetrievalMode, RegExp]>([
    ['retrieve', /^search/i],
    ['always_include', /^reference/i],
  ])('for a file already in the knowledge base, preselects its current mode (%s)', (currentMode, name) => {
    renderDialog({ currentMode });

    expect(screen.getByRole('radio', { name })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('dialog', { name: /re-ingest "\s*Customer_SRS\.docx\s*"/i })).toBeInTheDocument();
  });

  it('a file already in the knowledge base takes its current mode over the remembered folder choice', () => {
    renderDialog({ currentMode: 'retrieve', rememberedMode: 'always_include' });

    expect(search()).toHaveAttribute('aria-checked', 'true');
  });

  it('Cancel closes without confirming', async () => {
    const { onConfirm, onOpenChange } = renderDialog();

    await userEvent.click(screen.getByRole('button', { name: /^cancel$/i }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('disables the controls while the request is being sent', () => {
    renderDialog({ rememberedMode: 'retrieve', isSubmitting: true });

    expect(confirmButton()).toBeDisabled();
  });

  it('shows the file name bidirectionally safe, so a Hebrew name does not reorder the sentence', () => {
    renderDialog({ file: { name: 'מדריך.docx', sizeBytes: 1024 } });

    expect(document.querySelector('bdi[dir="auto"]')).toHaveTextContent('מדריך.docx');
  });
});
