import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route, Link } from 'react-router-dom';
import { BatchJobWizard } from './BatchJobWizard';
import { ToastProvider } from '../components/ToastProvider';
import * as batchesApi from '../api/batches';
import * as jobsApi from '../api/jobs';
import * as adoApi from '../api/ado';
import { useAuthStore } from '../store/authStore';
import { useBatchJobDraftStore } from '../store/batchJobDraftStore';

vi.mock('../api/batches');
vi.mock('../api/jobs');
vi.mock('../api/ado');

const previewOf = (blockCount: number, sectionCount: number) =>
  ({ blockCount, sectionCount, figureCount: 0, depth: 2, fileType: 'docx', tableCount: 0, openTbdCount: 0, documentMap: [] }) as any;

// Every page render checks the files it is given (B3) and may list models and projects; give those calls an answer by default.
beforeEach(() => {
  localStorage.clear();
  vi.mocked(jobsApi.previewJob).mockReset().mockResolvedValue(previewOf(10, 2));
  vi.mocked(jobsApi.getEstimate).mockReset().mockResolvedValue({ lowerMinutes: 1, upperMinutes: 2 } as any);
  vi.mocked(jobsApi.listJobs).mockReset().mockResolvedValue([]);
  vi.mocked(jobsApi.listModels).mockReset().mockResolvedValue({ models: [], recommended: null, details: [] });
  vi.mocked(adoApi.getProjects).mockReset().mockResolvedValue([]);
  vi.mocked(adoApi.getAreaPaths).mockResolvedValue({ path: 'Alpha', children: [] } as any);
  vi.mocked(adoApi.getIterationPaths).mockResolvedValue({ path: 'Alpha', children: [] } as any);
  vi.mocked(adoApi.getStates).mockResolvedValue(['Proposed'] as any);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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
    await userEvent.click(screen.getByText('With AI review'));

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
      await userEvent.click(screen.getByRole('radio', { name: /^With AI review/ }));

      await goAwayAndBack();

      expect(screen.getByText('a.docx')).toBeInTheDocument();
      expect(screen.getByText('b.docx')).toBeInTheDocument();
      expect(screen.getByLabelText(/area path/i)).toHaveValue('Project\\Area1');
      expect(screen.getByRole('radio', { name: /^With AI review/ })).toBeChecked();
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

describe('BatchJobWizard setup the way the single wizard does it', () => {
  function renderAs(userId: string | null, draft?: Parameters<ReturnType<typeof useBatchJobDraftStore.getState>['patch']>[0]) {
    useAuthStore.getState().logout(); // logging out clears the draft, so a draft under test is set after it
    if (userId) useAuthStore.getState().login('https://ado.example', 'Jane', userId);
    if (draft) useBatchJobDraftStore.getState().patch(draft);
    return render(
      <ToastProvider>
        <MemoryRouter>
          <BatchJobWizard />
        </MemoryRouter>
      </ToastProvider>,
    );
  }

  it('starts from the mode and destination the user chose last time, on a batch nobody has touched', () => {
    localStorage.setItem('req2ado-last-job:user-7', JSON.stringify({ mode: 'survey', project: 'Proj', areaPath: 'Proj\\Customer Requirements' }));
    useBatchJobDraftStore.getState().reset();
    renderAs('user-7');
    expect(screen.getByRole('radio', { name: /With AI review/i })).toBeChecked();
    expect(screen.getByRole('radio', { name: /Standard/i })).not.toBeChecked();
  });

  it('never replaces a draft the user already started with the remembered choices', () => {
    localStorage.setItem('req2ado-last-job:user-7', JSON.stringify({ mode: 'survey', project: 'Proj', areaPath: 'Proj\\A' }));
    renderAs('user-7', { mode: 'baseline', project: 'Other', areaPath: 'Other\\B' });
    expect(screen.getByRole('radio', { name: /Standard/i })).toBeChecked();
  });

  it('says why Start is unavailable, beside the button, and follows what is still missing', async () => {
    useBatchJobDraftStore.getState().reset();
    renderAs(null);
    const start = screen.getByRole('button', { name: /start batch/i });
    const reason = () => document.getElementById(start.getAttribute('aria-describedby') ?? '');
    expect(reason()).toHaveTextContent(/add at least one file/i);

    await userEvent.upload(screen.getByLabelText(/upload requirements documents/i), new File(['x'], 'req.docx'));
    expect(reason()).toHaveTextContent(/area path/i);

    await userEvent.type(screen.getByLabelText(/area path/i), 'Project\\Area1');
    expect(start).not.toBeDisabled();
    expect(start.getAttribute('aria-describedby')).toBeNull();
  });

  it('is titled as the batch page, not the generic app title', () => {
    useBatchJobDraftStore.getState().reset();
    renderAs(null);
    expect(document.title).toBe('New batch - req2ado');
  });
});

describe('BatchJobWizard: where to search for duplicates (B4)', () => {
  it('searches the area path and everything under it by default, with the single wizard\'s wording, and does not send a scope', async () => {
    vi.spyOn(batchesApi, 'submitBatch').mockResolvedValue({ batchId: 'batch-1', filesAccepted: 1, filesRejected: 0 });
    useBatchJobDraftStore.getState().reset();
    renderWizard();
    await userEvent.upload(screen.getByLabelText(/upload requirements documents/i), new File(['a'], 'a.docx'));
    await userEvent.type(screen.getByLabelText(/area path/i), 'Project\\Area1');

    expect(screen.getByLabelText(/search for duplicates in/i)).toHaveTextContent(/this area path and everything under it/i);
    await userEvent.click(screen.getByRole('button', { name: /start batch/i }));

    await waitFor(() => expect(batchesApi.submitBatch).toHaveBeenCalledWith(expect.objectContaining({ dedupScope: undefined })));
  });

  it('can be widened to the whole project: kept in the draft and sent with the batch', async () => {
    vi.spyOn(batchesApi, 'submitBatch').mockResolvedValue({ batchId: 'batch-1', filesAccepted: 1, filesRejected: 0 });
    useBatchJobDraftStore.getState().reset();
    renderWizard();
    await userEvent.upload(screen.getByLabelText(/upload requirements documents/i), new File(['a'], 'a.docx'));
    await userEvent.type(screen.getByLabelText(/area path/i), 'Project\\Area1');

    await userEvent.click(screen.getByLabelText(/search for duplicates in/i));
    await userEvent.click(await screen.findByRole('option', { name: /the whole project/i }));
    expect(useBatchJobDraftStore.getState().draft.dedupScope).toBe('project');
    await userEvent.click(screen.getByRole('button', { name: /start batch/i }));

    await waitFor(() => expect(batchesApi.submitBatch).toHaveBeenCalledWith(expect.objectContaining({ dedupScope: 'project' })));
  });

  it('comes back with the widened scope after leaving the page', () => {
    useAuthStore.getState().logout();
    useBatchJobDraftStore.getState().patch({ dedupScope: 'project', areaPath: 'Project\\Area1' });
    render(
      <ToastProvider>
        <MemoryRouter>
          <BatchJobWizard />
        </MemoryRouter>
      </ToastProvider>,
    );
    expect(screen.getByLabelText(/search for duplicates in/i)).toHaveTextContent(/the whole project/i);
  });
});

describe('BatchJobWizard: checks each file before the batch starts (B3)', () => {
  const upload = (files: File[]) => userEvent.upload(screen.getByLabelText(/upload requirements documents/i), files);
  const fileList = () => screen.getByRole('list', { name: /chosen files/i });
  const rowOf = (name: string) => within(fileList()).getByText(name).closest('li') as HTMLElement;

  it('shows the blocks and sections of each file, and announces only "Checked N of M files" at the end', async () => {
    const a = deferred<any>();
    const b = deferred<any>();
    vi.mocked(jobsApi.previewJob).mockImplementation((file: File) => (file.name === 'a.docx' ? a.promise : b.promise));
    useBatchJobDraftStore.getState().reset();
    renderWizard();
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('');

    await upload([new File(['a'], 'a.docx'), new File(['b'], 'b.docx')]);
    a.resolve(previewOf(42, 5));
    await waitFor(() => expect(rowOf('a.docx')).toHaveTextContent('42 blocks · 5 sections'));
    // One file done is not announced: only the end is.
    expect(status).toHaveTextContent('');

    b.resolve(previewOf(1, 1));
    await waitFor(() => expect(rowOf('b.docx')).toHaveTextContent('1 block · 1 section'));
    await waitFor(() => expect(status).toHaveTextContent('Checked 2 of 2 files'));
  });

  it('checks at most two files at a time', async () => {
    const pending = new Map<string, ReturnType<typeof deferred<any>>>();
    vi.mocked(jobsApi.previewJob).mockImplementation((file: File) => {
      const d = deferred<any>();
      pending.set(file.name, d);
      return d.promise;
    });
    useBatchJobDraftStore.getState().reset();
    renderWizard();

    await upload([new File(['a'], 'a.docx'), new File(['b'], 'b.docx'), new File(['c'], 'c.docx')]);
    await waitFor(() => expect(jobsApi.previewJob).toHaveBeenCalledTimes(2));
    expect(pending.has('c.docx')).toBe(false);

    pending.get('a.docx')!.resolve(previewOf(3, 1));
    await waitFor(() => expect(jobsApi.previewJob).toHaveBeenCalledTimes(3));
    expect(pending.has('c.docx')).toBe(true);
  });

  it('drops the check of a file removed while it was being checked, and does not count it', async () => {
    const pending = new Map<string, ReturnType<typeof deferred<any>>>();
    vi.mocked(jobsApi.previewJob).mockImplementation((file: File) => {
      const d = deferred<any>();
      pending.set(file.name, d);
      return d.promise;
    });
    useBatchJobDraftStore.getState().reset();
    renderWizard();

    await upload([new File(['a'], 'a.docx'), new File(['b'], 'b.docx'), new File(['c'], 'c.docx')]);
    await waitFor(() => expect(jobsApi.previewJob).toHaveBeenCalledTimes(2));
    await userEvent.click(screen.getByLabelText('Remove a.docx'));
    // The removed file's request is still running, so the third file still waits: never more than two at once.
    expect(jobsApi.previewJob).toHaveBeenCalledTimes(2);

    pending.get('a.docx')!.resolve(previewOf(99, 9));
    await waitFor(() => expect(jobsApi.previewJob).toHaveBeenCalledTimes(3));
    pending.get('b.docx')!.resolve(previewOf(3, 1));
    pending.get('c.docx')!.resolve(previewOf(4, 1));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Checked 2 of 2 files'));
    expect(screen.queryByText(/99 blocks/)).not.toBeInTheDocument();
  });

  it('says in plain words when a file could not be checked, and that file does not block Start', async () => {
    vi.spyOn(batchesApi, 'submitBatch').mockResolvedValue({ batchId: 'batch-1', filesAccepted: 2, filesRejected: 0 });
    vi.mocked(jobsApi.previewJob).mockImplementation((file: File) => (file.name === 'bad.pdf' ? Promise.reject(new Error('422')) : Promise.resolve(previewOf(5, 2))));
    useBatchJobDraftStore.getState().reset();
    renderWizard();

    await upload([new File(['a'], 'a.docx'), new File(['b'], 'bad.pdf')]);
    await waitFor(() => expect(rowOf('bad.pdf')).toHaveTextContent(/could not check this file/i));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Checked 1 of 2 files'));

    await userEvent.type(screen.getByLabelText(/area path/i), 'Project\\Area1');
    const start = screen.getByRole('button', { name: /start batch/i });
    expect(start).not.toBeDisabled();
    await userEvent.click(start);
    await waitFor(() =>
      expect(batchesApi.submitBatch).toHaveBeenCalledWith(
        expect.objectContaining({ files: [expect.objectContaining({ name: 'a.docx' }), expect.objectContaining({ name: 'bad.pdf' })] }),
      ),
    );
  });

  it('notes a file whose name was already run, in the single wizard\'s words', async () => {
    vi.mocked(jobsApi.listJobs).mockResolvedValue([
      { id: 'abcdef1234567890', originalFilename: 'a.docx', createdAt: new Date().toISOString(), status: 'COMPLETED' } as any,
    ]);
    useBatchJobDraftStore.getState().reset();
    renderWizard();

    await upload([new File(['a'], 'a.docx'), new File(['b'], 'b.docx')]);
    await waitFor(() => expect(rowOf('a.docx')).toHaveTextContent(/you already ran a file with this name/i));
    expect(within(rowOf('a.docx')).getByRole('link', { name: 'abcdef12' })).toHaveAttribute('href', '/jobs/abcdef1234567890');
    expect(rowOf('b.docx')).not.toHaveTextContent(/already ran/i);
  });

  it('shows each file\'s estimate for the chosen mode, one estimate per file, and the total of all files', async () => {
    vi.mocked(jobsApi.previewJob).mockImplementation((file: File) => Promise.resolve(file.name === 'a.docx' ? previewOf(42, 5) : previewOf(100, 8)));
    vi.mocked(jobsApi.getEstimate).mockImplementation(async ({ blockCount, mode }) =>
      (mode === 'baseline'
        ? blockCount === 42 ? { lowerMinutes: 10, upperMinutes: 20 } : { lowerMinutes: 30, upperMinutes: 40 }
        : blockCount === 42 ? { lowerMinutes: 50, upperMinutes: 70 } : { lowerMinutes: 60, upperMinutes: 90 }) as any,
    );
    useBatchJobDraftStore.getState().reset();
    renderWizard();

    await upload([new File(['a'], 'a.docx'), new File(['b'], 'b.docx')]);
    await waitFor(() => expect(rowOf('a.docx')).toHaveTextContent('10 min – 20 min'));
    await waitFor(() => expect(rowOf('b.docx')).toHaveTextContent('30 min – 40 min'));
    expect(screen.getByTestId('batch-total-estimate')).toHaveTextContent('40 min – 1h');
    expect(vi.mocked(jobsApi.getEstimate).mock.calls.filter(([p]) => p.mode === 'baseline')).toHaveLength(2);
    expect(vi.mocked(jobsApi.getEstimate)).toHaveBeenCalledWith(expect.objectContaining({ blockCount: 42, mode: 'baseline' }));

    await userEvent.click(screen.getByRole('radio', { name: /^With AI review/ }));
    await waitFor(() => expect(rowOf('a.docx')).toHaveTextContent('50 min – 1h 10m'));
    expect(screen.getByTestId('batch-total-estimate')).toHaveTextContent('1h 50m – 2h 40m');
    // The SURVEY throttle note stays beside the total.
    expect(screen.getByText(/2 files selected/i)).toBeInTheDocument();
    expect(vi.mocked(jobsApi.getEstimate).mock.calls.filter(([p]) => p.mode === 'survey')).toHaveLength(2);
  });

  it('leaves out a file that could not be checked from the total, and says so', async () => {
    vi.mocked(jobsApi.previewJob).mockImplementation((file: File) => (file.name === 'bad.pdf' ? Promise.reject(new Error('x')) : Promise.resolve(previewOf(42, 5))));
    vi.mocked(jobsApi.getEstimate).mockResolvedValue({ lowerMinutes: 10, upperMinutes: 20 } as any);
    useBatchJobDraftStore.getState().reset();
    renderWizard();

    await upload([new File(['a'], 'a.docx'), new File(['b'], 'bad.pdf')]);
    await waitFor(() => expect(screen.getByTestId('batch-total-estimate')).toHaveTextContent('10 min – 20 min'));
    expect(screen.getByText(/not counting 1 file that could not be checked/i)).toBeInTheDocument();
  });
});

describe('BatchJobWizard: remembers the last choice per Team Project (B6)', () => {
  function renderSignedIn() {
    useAuthStore.getState().logout();
    useAuthStore.getState().login('https://ado.example', 'Jane', 'user-7');
    useBatchJobDraftStore.getState().reset();
    vi.mocked(adoApi.getProjects).mockResolvedValue([{ id: '1', name: 'Alpha' }, { id: '2', name: 'Beta' }] as any);
    return render(
      <ToastProvider>
        <MemoryRouter>
          <BatchJobWizard />
        </MemoryRouter>
      </ToastProvider>,
    );
  }
  const pickProject = async (name: string) => {
    await userEvent.click(screen.getByLabelText(/team project/i));
    await userEvent.click(await screen.findByRole('option', { name }));
  };

  it('fills the area path and the mode from the picked project\'s last batch or job, when the mode was not chosen', async () => {
    localStorage.setItem('req2ado-last-job-by-project:user-7', JSON.stringify({ Alpha: { mode: 'survey', areaPath: 'Alpha\\Reqs' } }));
    renderSignedIn();

    await pickProject('Alpha');

    expect(await screen.findByLabelText(/area path/i)).toHaveValue('Alpha\\Reqs');
    expect(screen.getByRole('radio', { name: /^With AI review/ })).toBeChecked();
  });

  it('never replaces a mode the user already chose', async () => {
    localStorage.setItem('req2ado-last-job-by-project:user-7', JSON.stringify({ Alpha: { mode: 'baseline', areaPath: 'Alpha\\Reqs' } }));
    renderSignedIn();
    await userEvent.click(screen.getByRole('radio', { name: /^With AI review/ }));

    await pickProject('Alpha');

    expect(await screen.findByLabelText(/area path/i)).toHaveValue('Alpha\\Reqs');
    expect(screen.getByRole('radio', { name: /^With AI review/ })).toBeChecked();
  });

  it('remembers the batch\'s choices under its project when it starts', async () => {
    vi.spyOn(batchesApi, 'submitBatch').mockResolvedValue({ batchId: 'batch-1', filesAccepted: 1, filesRejected: 0 });
    renderSignedIn();
    await userEvent.upload(screen.getByLabelText(/upload requirements documents/i), new File(['a'], 'a.docx'));
    await pickProject('Beta');
    await userEvent.type(await screen.findByLabelText(/area path/i), 'Beta');
    await userEvent.click(screen.getByRole('button', { name: /start batch/i }));

    await waitFor(() => expect(batchesApi.submitBatch).toHaveBeenCalled());
    expect(JSON.parse(localStorage.getItem('req2ado-last-job-by-project:user-7') ?? 'null')).toEqual({ Beta: { mode: 'baseline', areaPath: 'Beta' } });
  });
});
