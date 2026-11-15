import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RubricDialog } from './RubricDialog';
import { ToastProvider } from './ToastProvider';
import * as kbApi from '../api/kb';

vi.mock('../api/kb');

function renderDialog(open = true, onOpenChange = vi.fn()) {
  render(
    <ToastProvider>
      <RubricDialog open={open} onOpenChange={onOpenChange} />
    </ToastProvider>,
  );
  return { onOpenChange };
}

describe('RubricDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(kbApi.getRubric).mockResolvedValue({
      version: 'v1', source: 'kb', builtAt: null, removed: [],
      categories: [{ name: 'Testable', passCondition: 'Can be verified', guidance: null, pinned: false, origin: 'kb', sources: ['A.pptx'], mergedFrom: ['Testable'] }],
    });
  });

  it('shows the rubric, unchanged, inside a dialog', async () => {
    renderDialog();

    const dialog = await screen.findByRole('dialog', { name: /grading rubric/i });
    expect(await within(dialog).findByLabelText('Pass condition of Testable')).toHaveValue('Can be verified');
  });

  it('does not read the rubric until it is opened', () => {
    renderDialog(false);

    expect(kbApi.getRubric).not.toHaveBeenCalled();
  });

  it('can be closed', async () => {
    const { onOpenChange } = renderDialog();

    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /^close$/i }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
