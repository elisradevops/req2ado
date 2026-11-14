import { render, screen, waitFor, within } from '@testing-library/react';
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
});
