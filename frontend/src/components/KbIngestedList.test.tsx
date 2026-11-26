import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { vi } from 'vitest';
import * as kbApi from '../api/kb';
import { KbIngestedList } from './KbIngestedList';

vi.mock('../api/kb');

const doc = (overrides: Partial<kbApi.IngestedDocument> = {}): kbApi.IngestedDocument => ({
  id: 'd1', userId: 'u', driveItemId: 'i1', name: 'Standard.pdf', sizeBytes: 231_000, mimeType: 'application/pdf', docType: null,
  retrievalMode: 'retrieve', ingestedAt: '2026-11-12T17:53:00Z', chunkCount: 32, ...overrides,
});

describe('KbIngestedList', () => {
  it('lists what is already in the knowledge base, with chunks and how each file is used, without needing SharePoint', async () => {
    vi.mocked(kbApi.listIngestedDocuments).mockResolvedValue([doc(), doc({ id: 'd2', name: 'Guidelines.pdf', chunkCount: 26, retrievalMode: 'always_include' })]);
    render(<KbIngestedList />);

    const list = await screen.findByRole('list', { name: /in your knowledge base/i });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('Standard.pdf');
    expect(items[0]).toHaveTextContent('32 chunks');
    expect(items[1]).toHaveTextContent('Always included');
    expect(screen.getByRole('heading', { name: /in your knowledge base/i })).toHaveTextContent('2');
  });

  it('says plainly when there is nothing yet, and what to do', async () => {
    vi.mocked(kbApi.listIngestedDocuments).mockResolvedValue([]);
    render(<KbIngestedList />);
    expect(await screen.findByText(/no documents yet/i)).toBeInTheDocument();
  });

  it('says it could not load the list, instead of showing an empty one', async () => {
    vi.mocked(kbApi.listIngestedDocuments).mockRejectedValue(new Error('down'));
    render(<KbIngestedList />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/couldn.t load/i));
    expect(screen.queryByText(/no documents yet/i)).not.toBeInTheDocument();
  });

  it('shows a singular chunk count and an unknown one for a file added before chunks were counted', async () => {
    vi.mocked(kbApi.listIngestedDocuments).mockResolvedValue([doc({ chunkCount: 1 }), doc({ id: 'd2', name: 'Old.pdf', chunkCount: null })]);
    render(<KbIngestedList />);
    const items = await screen.findAllByRole('listitem');
    expect(items[0]).toHaveTextContent('1 chunk');
    expect(items[0]).not.toHaveTextContent('1 chunks');
    expect(items[1]).toHaveTextContent('chunks not counted');
  });

  it('reads the list again, without flashing the loading skeleton, when told a file was added or removed', async () => {
    vi.mocked(kbApi.listIngestedDocuments).mockClear();
    vi.mocked(kbApi.listIngestedDocuments).mockResolvedValueOnce([doc()]).mockResolvedValueOnce([doc(), doc({ id: 'd2', name: 'Added.pdf' })]);
    const { rerender } = render(<KbIngestedList refreshKey={0} />);
    await screen.findByText('Standard.pdf');

    rerender(<KbIngestedList refreshKey={1} />);
    expect(screen.getByText('Standard.pdf')).toBeInTheDocument();
    expect(await screen.findByText('Added.pdf')).toBeInTheDocument();
    expect(kbApi.listIngestedDocuments).toHaveBeenCalledTimes(2);
  });

  it('offers a check for unlisted content that starts only when asked, and removes nothing by itself', async () => {
    vi.mocked(kbApi.listIngestedDocuments).mockResolvedValue([doc()]);
    vi.mocked(kbApi.reconcileKbOrphans).mockReset();
    vi.mocked(kbApi.reconcileKbOrphans).mockResolvedValue({ dryRun: true, orphans: [], removed: 0, failed: [] });
    render(<KbIngestedList />);

    const button = await screen.findByRole('button', { name: 'Check for unlisted content' });
    expect(kbApi.reconcileKbOrphans).not.toHaveBeenCalled();

    const { default: userEvent } = await import('@testing-library/user-event');
    await userEvent.click(button);

    expect(await screen.findByText(/nothing unlisted found/i)).toBeInTheDocument();
    expect(kbApi.reconcileKbOrphans).toHaveBeenCalledTimes(1);
    expect(kbApi.reconcileKbOrphans).toHaveBeenCalledWith(true);
  });
});


// Owner finding (2026-11-26): files the folder tree cannot reach (legacy, or of a type req2ado does not read) stayed in the knowledge base
// and kept grounding scoring. Every file can be removed from this list, and those two kinds are labelled and can be removed together.
describe('KbIngestedList: removing files from the list', () => {
  const docs = [
    doc({ id: 'a', name: 'Current.pdf', status: 'current' }),
    doc({ id: 'b', name: 'Old spec.docx', status: 'legacy' }),
    doc({ id: 'c', name: 'Bundle.zip', status: 'unsupported' }),
    doc({ id: 'd', name: 'Drawing.vsdx', status: 'unsupported' }),
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(kbApi.listIngestedDocuments).mockResolvedValue(docs);
    vi.mocked(kbApi.deleteIngestedDocument).mockResolvedValue(undefined);
  });

  it('labels legacy and unsupported files, and says why', async () => {
    render(<KbIngestedList />);
    const items = within(await screen.findByRole('list', { name: /in your knowledge base/i })).getAllByRole('listitem');
    expect(items[0]).not.toHaveTextContent(/legacy|not supported/i);
    expect(within(items[1]).getByText('Legacy')).toHaveAttribute('title', expect.stringMatching(/folder tree/i));
    expect(within(items[2]).getByText('Not supported')).toHaveAttribute('title', expect.stringMatching(/does not read/i));
  });

  it('removes one file after confirming, and reports it', async () => {
    const onRemoved = vi.fn();
    render(<KbIngestedList onRemoved={onRemoved} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Old spec.docx from your knowledge base' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Old spec.docx');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove document' }));
    await waitFor(() => expect(kbApi.deleteIngestedDocument).toHaveBeenCalledWith('b'));
    await waitFor(() => expect(onRemoved).toHaveBeenCalledWith({ removed: 1, failed: [] }));
  });

  it('filters to the unsupported files and removes all of them after one confirmation', async () => {
    const onRemoved = vi.fn();
    render(<KbIngestedList onRemoved={onRemoved} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Not supported · 2' }));
    const list = screen.getByRole('list', { name: /in your knowledge base/i });
    expect(within(list).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      expect.stringContaining('Bundle.zip'),
      expect.stringContaining('Drawing.vsdx'),
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Remove all 2' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent(/2 files/);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove 2 files' }));
    await waitFor(() => expect(onRemoved).toHaveBeenCalledWith({ removed: 2, failed: [] }));
    expect(vi.mocked(kbApi.deleteIngestedDocument).mock.calls.map((c) => c[0])).toEqual(['c', 'd']);
  });

  it('reports a file that could not be removed, and keeps going with the rest', async () => {
    vi.mocked(kbApi.deleteIngestedDocument).mockImplementation(async (id) => {
      if (id === 'c') throw new Error('boom');
    });
    const onRemoved = vi.fn();
    render(<KbIngestedList onRemoved={onRemoved} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Not supported · 2' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove all 2' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove 2 files' }));
    await waitFor(() => expect(onRemoved).toHaveBeenCalledWith({ removed: 1, failed: ['Bundle.zip'] }));
  });
});
