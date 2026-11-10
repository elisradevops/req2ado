import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route, Link } from 'react-router-dom';
import { BatchJobWizard } from './BatchJobWizard';
import { ToastProvider } from '../components/ToastProvider';
import * as batchesApi from '../api/batches';
import { useAuthStore } from '../store/authStore';
import { useBatchJobDraftStore } from '../store/batchJobDraftStore';

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

  describe('keeps the draft when the user leaves for another page and comes back', () => {
    function renderWithAwayRoute() {
      useAuthStore.getState().logout();
      return render(
        <ToastProvider>
          <MemoryRouter initialEntries={['/jobs/batch']}>
            <Routes>
              <Route path="/jobs/batch" element={<><BatchJobWizard /><Link to="/away">go away</Link></>} />
              <Route path="/away" element={<Link to="/jobs/batch">come back</Link>} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>,
      );
    }
    const goAwayAndBack = async () => {
      await userEvent.click(screen.getByRole('link', { name: 'go away' }));
      await userEvent.click(screen.getByRole('link', { name: 'come back' }));
    };

    it('returns with the same files, mode and typed area path', async () => {
      vi.spyOn(batchesApi, 'submitBatch');
      renderWithAwayRoute();
      await userEvent.upload(screen.getByLabelText(/upload requirements documents/i), [new File(['a'], 'a.docx'), new File(['b'], 'b.docx')]);
      await userEvent.type(screen.getByLabelText(/area path/i), 'Project\\Area1');
      await userEvent.click(screen.getByRole('radio', { name: /^SURVEY/ }));

      await goAwayAndBack();

      expect(screen.getByText('a.docx')).toBeInTheDocument();
      expect(screen.getByText('b.docx')).toBeInTheDocument();
      expect(screen.getByLabelText(/area path/i)).toHaveValue('Project\\Area1');
      expect(screen.getByRole('radio', { name: /^SURVEY/ })).toBeChecked();
      expect(screen.getByRole('button', { name: /start batch/i })).not.toBeDisabled();
    });

    it('does not add the same file twice, e.g. when it is chosen again after coming back', async () => {
      renderWithAwayRoute();
      const same = new File(['a'], 'a.docx', { lastModified: 1000 });
      await userEvent.upload(screen.getByLabelText(/upload requirements documents/i), same);
      await goAwayAndBack();
      await userEvent.upload(screen.getByLabelText(/upload requirements documents/i), new File(['a'], 'a.docx', { lastModified: 1000 }));

      expect(screen.getAllByText('a.docx')).toHaveLength(1);
    });

    it('keeps two different files that merely share a name', async () => {
      renderWithAwayRoute();
      await userEvent.upload(screen.getByLabelText(/upload requirements documents/i), [new File(['a'], 'a.docx', { lastModified: 1 }), new File(['bb'], 'a.docx', { lastModified: 2 })]);

      expect(screen.getAllByText('a.docx')).toHaveLength(2);
    });

    it('keeps the files that were removed out, not the originals', async () => {
      renderWithAwayRoute();
      await userEvent.upload(screen.getByLabelText(/upload requirements documents/i), [new File(['a'], 'a.docx'), new File(['b'], 'b.docx')]);
      await userEvent.click(screen.getAllByRole('button', { name: /remove/i })[0]);

      await goAwayAndBack();

      expect(screen.queryByText('a.docx')).not.toBeInTheDocument();
      expect(screen.getByText('b.docx')).toBeInTheDocument();
    });

    it('starts fresh after the batch was started', async () => {
      vi.spyOn(batchesApi, 'submitBatch').mockResolvedValue({ batchId: 'batch-1', filesAccepted: 1, filesRejected: 0 });
      renderWithAwayRoute();
      await userEvent.upload(screen.getByLabelText(/upload requirements documents/i), new File(['a'], 'a.docx'));
      await userEvent.type(screen.getByLabelText(/area path/i), 'Project\\Area1');
      await userEvent.click(screen.getByRole('button', { name: /start batch/i }));

      await waitFor(() => expect(useBatchJobDraftStore.getState().draft.files).toEqual([]));
      expect(useBatchJobDraftStore.getState().draft.areaPath).toBe('');
    });

    it('falls back to Default when the restored model is no longer offered', async () => {
      useBatchJobDraftStore.getState().patch({ mode: 'survey', model: 'gone-model' });
      const jobsApi = await import('../api/jobs');
      vi.spyOn(jobsApi, 'listModels').mockResolvedValue({ models: ['still-here'], recommended: null, details: [] });
      render(
        <ToastProvider>
          <MemoryRouter>
            <BatchJobWizard />
          </MemoryRouter>
        </ToastProvider>,
      );
      await waitFor(() => expect(useBatchJobDraftStore.getState().draft.model).toBe(''));
    });
  });
});
