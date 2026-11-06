import { beforeEach, describe, expect, it } from 'vitest';
import { EMPTY_BATCH_DRAFT, useBatchJobDraftStore } from './batchJobDraftStore';
import { useAuthStore } from './authStore';

describe('batchJobDraftStore', () => {
  beforeEach(() => useBatchJobDraftStore.getState().reset());

  it('starts empty, in BASELINE', () => {
    expect(useBatchJobDraftStore.getState().draft).toEqual(EMPTY_BATCH_DRAFT);
    expect(EMPTY_BATCH_DRAFT).toMatchObject({ files: [], mode: 'baseline', project: '', areaPath: '' });
  });

  it('merges a patch and keeps the rest', () => {
    const files = [new File(['a'], 'a.docx')];
    useBatchJobDraftStore.getState().patch({ files, mode: 'survey' });
    useBatchJobDraftStore.getState().patch({ areaPath: 'P\\A' });
    expect(useBatchJobDraftStore.getState().draft).toMatchObject({ files, mode: 'survey', areaPath: 'P\\A' });
  });

  it('reset drops the files too', () => {
    useBatchJobDraftStore.getState().patch({ files: [new File(['a'], 'a.docx')] });
    useBatchJobDraftStore.getState().reset();
    expect(useBatchJobDraftStore.getState().draft.files).toEqual([]);
  });

  it('is cleared on logout, so the next user in this tab never inherits the previous user\'s files', () => {
    useBatchJobDraftStore.getState().patch({ files: [new File(['a'], 'a.docx')], project: 'P' });
    useAuthStore.getState().logout();
    expect(useBatchJobDraftStore.getState().draft).toEqual(EMPTY_BATCH_DRAFT);
  });
});
