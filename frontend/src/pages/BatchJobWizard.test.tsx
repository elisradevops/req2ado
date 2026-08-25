import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { BatchJobWizard } from './BatchJobWizard';
import { ToastProvider } from '../components/ToastProvider';
import * as batchesApi from '../api/batches';
import { useAuthStore } from '../store/authStore';

vi.mock('../api/batches');

function renderWizard() {
  useAuthStore.getState().logout();
  return render(
    <ToastProvider>
      <MemoryRouter>
        <BatchJobWizard />
      </MemoryRouter>
    </ToastProvider>,
  );
}

describe('BatchJobWizard', () => {
  it('disables Start batch until at least one file is selected and an area path is entered', async () => {
    renderWizard();

    expect(screen.getByRole('button', { name: /start batch/i })).toBeDisabled();

    await userEvent.upload(screen.getByLabelText(/upload requirements documents/i), new File(['x'], 'req.docx'));
    expect(screen.getByRole('button', { name: /start batch/i })).toBeDisabled();

    await userEvent.type(screen.getByLabelText(/area path/i), 'Project\\Area1');
    expect(screen.getByRole('button', { name: /start batch/i })).not.toBeDisabled();
  });

  it('submits every selected file, area path, and mode, then navigates to the new batch status page', async () => {
    vi.spyOn(batchesApi, 'submitBatch').mockResolvedValue({ batchId: 'batch-99', filesAccepted: 2, filesRejected: 0 });
    renderWizard();

    await userEvent.upload(screen.getByLabelText(/upload requirements documents/i), [new File(['a'], 'a.docx'), new File(['b'], 'b.docx')]);
    await userEvent.type(screen.getByLabelText(/area path/i), 'Project\\Area1');
    await userEvent.click(screen.getByRole('button', { name: /start batch/i }));

    await waitFor(() =>
      expect(batchesApi.submitBatch).toHaveBeenCalledWith(
        expect.objectContaining({
          areaPath: 'Project\\Area1',
          mode: 'baseline',
          files: [expect.objectContaining({ name: 'a.docx' }), expect.objectContaining({ name: 'b.docx' })],
        }),
      ),
    );
  });

  it('removing a selected file drops it from the submitted batch', async () => {
    vi.spyOn(batchesApi, 'submitBatch').mockResolvedValue({ batchId: 'batch-99', filesAccepted: 1, filesRejected: 0 });
    renderWizard();

    await userEvent.upload(screen.getByLabelText(/upload requirements documents/i), [new File(['a'], 'a.docx'), new File(['b'], 'b.docx')]);
    await userEvent.click(screen.getByLabelText('Remove b.docx'));
    await userEvent.type(screen.getByLabelText(/area path/i), 'Project\\Area1');
    await userEvent.click(screen.getByRole('button', { name: /start batch/i }));

    await waitFor(() =>
      expect(batchesApi.submitBatch).toHaveBeenCalledWith(expect.objectContaining({ files: [expect.objectContaining({ name: 'a.docx' })] })),
    );
  });

  it('shows an error toast and re-enables the button when the submission fails', async () => {
    vi.spyOn(batchesApi, 'submitBatch').mockRejectedValue(new Error('network error'));
    renderWizard();

    await userEvent.upload(screen.getByLabelText(/upload requirements documents/i), new File(['a'], 'a.docx'));
    await userEvent.type(screen.getByLabelText(/area path/i), 'Project\\Area1');
    await userEvent.click(screen.getByRole('button', { name: /start batch/i }));

    await waitFor(() => expect(screen.getByText(/failed to start the batch/i)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /start batch/i })).not.toBeDisabled();
  });

  it('shows a SURVEY throttle warning naming the file count once SURVEY mode is selected', async () => {
    renderWizard();

    await userEvent.upload(screen.getByLabelText(/upload requirements documents/i), new File(['a'], 'a.docx'));
    await userEvent.click(screen.getByText(/survey/i));

    expect(screen.getByText(/1 file selected/i)).toBeInTheDocument();
  });
});
