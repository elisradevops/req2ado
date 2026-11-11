import { describe, it, expect, vi } from 'vitest';
import { httpClient } from './httpClient';
import {
  cancelKbIngestBatch,
  createKbIngestBatch,
  getKbIngestBatch,
  getKbProfile,
  ingestFolderUrl,
  ingestUrl,
  listIngestedDocuments,
  listKbIngestBatches,
  resumeKbIngestBatch,
  retryFailedKbIngestBatch,
} from './kb';

vi.mock('./httpClient');

describe('kb api', () => {
  it('ingestUrl POSTs the url, userId, and docType to /kb/ingest-url', async () => {
    const result = {
      documentName: 'spec.docx',
      driveitemId: 'drive-1',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      sizeBytes: 1024,
      chunksStored: 3,
      skippedUnchanged: false,
    };
    (httpClient.post as any).mockResolvedValue({ data: result });

    const response = await ingestUrl('https://share.example/spec.docx', 'Project\\Area1', 'spec');

    expect(httpClient.post).toHaveBeenCalledWith('/kb/ingest-url', {
      url: 'https://share.example/spec.docx',
      userId: 'Project\\Area1',
      docType: 'spec',
    });
    expect(response).toEqual(result);
  });

  it('listIngestedDocuments() GETs /kb/documents with no params', async () => {
    const docs = [{ id: 'doc-1', userId: 'Project\\Area1', driveItemId: 'drive-1', name: 'spec.docx', sizeBytes: 1024, mimeType: null, docType: null, ingestedAt: '2026-07-12T00:00:00Z' }];
    (httpClient.get as any).mockResolvedValue({ data: docs });

    const result = await listIngestedDocuments();

    expect(httpClient.get).toHaveBeenCalledWith('/kb/documents', { params: {} });
    expect(result).toEqual(docs);
  });

  it('listIngestedDocuments("Area1") GETs /kb/documents with params: { userId: "Area1" }', async () => {
    const docs: any[] = [];
    (httpClient.get as any).mockResolvedValue({ data: docs });

    const result = await listIngestedDocuments('Area1');

    expect(httpClient.get).toHaveBeenCalledWith('/kb/documents', { params: { userId: 'Area1' } });
    expect(result).toEqual(docs);
  });

  it('ingestFolderUrl POSTs the url, userId, and docType to /kb/ingest-folder-url', async () => {
    const result = { files: [{ file: 'a.docx', status: 'ingested', chunksStored: 2, driveitemId: 'd1', mimeType: null, sizeBytes: 100, reason: null }] };
    (httpClient.post as any).mockResolvedValue({ data: result });

    const response = await ingestFolderUrl('https://share.example/folder', 'Project\\Area1', 'spec');

    expect(httpClient.post).toHaveBeenCalledWith('/kb/ingest-folder-url', {
      url: 'https://share.example/folder',
      userId: 'Project\\Area1',
      docType: 'spec',
    });
    expect(response).toEqual(result);
  });
});


describe('the rubric', () => {
  const rubric = { version: 'v1', source: 'kb', builtAt: null, categories: [], removed: [] };

  it('getRubric reads the rubric of the session user', async () => {
    const { httpClient } = await import('./httpClient');
    (httpClient.get as any).mockResolvedValue({ data: rubric });
    const { getRubric } = await import('./kb');
    expect(await getRubric()).toEqual(rubric);
    expect(httpClient.get).toHaveBeenCalledWith('/kb/rubric');
  });

  it('putRubric stores the pins and removals and returns the rubric that results', async () => {
    const { httpClient } = await import('./httpClient');
    (httpClient.put as any).mockResolvedValue({ data: rubric });
    const { putRubric } = await import('./kb');
    const input = { pinned: [{ name: 'Testable', passCondition: 'Pinned' }], removed: ['Essential'] };
    expect(await putRubric(input)).toEqual(rubric);
    expect(httpClient.put).toHaveBeenCalledWith('/kb/rubric', input);
  });

  describe('batch ingest', () => {
    const batch = { id: 'b1', status: 'queued' };

    it('createKbIngestBatch POSTs the files and where they came from to /kb/ingest-batches', async () => {
      (httpClient.post as any).mockResolvedValue({ data: batch });
      const input = {
        driveId: 'drive-1', folderItemId: 'folder-1', folderPath: 'Sub', docType: null,
        items: [{ itemId: 'i1', name: 'a.pdf', relativePath: 'Sub/a.pdf', sizeBytes: 10, retrievalMode: 'retrieve' as const }],
      };

      expect(await createKbIngestBatch(input)).toEqual(batch);
      expect(httpClient.post).toHaveBeenCalledWith('/kb/ingest-batches', input);
    });

    it('listKbIngestBatches asks only for active batches when told to, with the limit', async () => {
      (httpClient.get as any).mockResolvedValue({ data: [batch] });

      expect(await listKbIngestBatches({ active: true, limit: 3 })).toEqual([batch]);
      expect(httpClient.get).toHaveBeenCalledWith('/kb/ingest-batches', { params: { active: 'true', limit: 3 } });
    });

    it('listKbIngestBatches sends no params when none are given', async () => {
      (httpClient.get as any).mockResolvedValue({ data: [] });

      await listKbIngestBatches();

      expect(httpClient.get).toHaveBeenCalledWith('/kb/ingest-batches', { params: {} });
    });

    it('getKbIngestBatch GETs one batch by id', async () => {
      (httpClient.get as any).mockResolvedValue({ data: batch });

      expect(await getKbIngestBatch('b1')).toEqual(batch);
      expect(httpClient.get).toHaveBeenCalledWith('/kb/ingest-batches/b1');
    });

    it.each([
      ['cancel', cancelKbIngestBatch],
      ['retry-failed', retryFailedKbIngestBatch],
      ['resume', resumeKbIngestBatch],
    ])('%s POSTs to the batch\'s own action', async (action, call) => {
      (httpClient.post as any).mockResolvedValue({ data: batch });

      expect(await call('b1')).toEqual(batch);
      expect(httpClient.post).toHaveBeenCalledWith(`/kb/ingest-batches/b1/${action}`);
    });

    it('getKbProfile GETs the grading rubric state', async () => {
      const view = { state: 'ready', docs: [] };
      (httpClient.get as any).mockResolvedValue({ data: view });

      expect(await getKbProfile()).toEqual(view);
      expect(httpClient.get).toHaveBeenCalledWith('/kb/profile');
    });
  });
});
