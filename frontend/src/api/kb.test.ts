import { describe, it, expect, vi } from 'vitest';
import { httpClient } from './httpClient';
import { ingestUrl, listIngestedDocuments } from './kb';

vi.mock('./httpClient');

describe('kb api', () => {
  it('ingestUrl POSTs the url, areaPath, and docType to /kb/ingest-url', async () => {
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
      areaPath: 'Project\\Area1',
      docType: 'spec',
    });
    expect(response).toEqual(result);
  });

  it('listIngestedDocuments() GETs /kb/documents with no params', async () => {
    const docs = [{ id: 'doc-1', areaPath: 'Project\\Area1', driveItemId: 'drive-1', name: 'spec.docx', sizeBytes: 1024, mimeType: null, docType: null, ingestedAt: '2026-07-12T00:00:00Z' }];
    (httpClient.get as any).mockResolvedValue({ data: docs });

    const result = await listIngestedDocuments();

    expect(httpClient.get).toHaveBeenCalledWith('/kb/documents', { params: {} });
    expect(result).toEqual(docs);
  });

  it('listIngestedDocuments("Area1") GETs /kb/documents with params: { areaPath: "Area1" }', async () => {
    const docs: any[] = [];
    (httpClient.get as any).mockResolvedValue({ data: docs });

    const result = await listIngestedDocuments('Area1');

    expect(httpClient.get).toHaveBeenCalledWith('/kb/documents', { params: { areaPath: 'Area1' } });
    expect(result).toEqual(docs);
  });
});
