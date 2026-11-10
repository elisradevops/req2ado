import { beforeEach, describe, expect, it } from 'vitest';
import { EMPTY_DRAFT, useNewJobDraftStore } from './newJobDraftStore';
import { useAuthStore } from './authStore';

describe('newJobDraftStore', () => {
  beforeEach(() => useNewJobDraftStore.getState().reset());

  it('starts empty, at step 1 in BASELINE', () => {
    expect(useNewJobDraftStore.getState().draft).toEqual(EMPTY_DRAFT);
    expect(EMPTY_DRAFT).toMatchObject({ step: 1, file: null, preview: null, parseStatus: 'idle', mode: 'baseline', project: '', areaPath: '' });
  });

  it('merges a patch and keeps the rest of the draft', () => {
    const file = new File(['x'], 'a.docx');
    useNewJobDraftStore.getState().patch({ file, mode: 'survey' });
    useNewJobDraftStore.getState().patch({ project: 'P' });
    expect(useNewJobDraftStore.getState().draft).toMatchObject({ file, mode: 'survey', project: 'P', step: 1 });
  });

  it('reset drops everything, including the file', () => {
    useNewJobDraftStore.getState().patch({ file: new File(['x'], 'a.docx'), step: 3 });
    useNewJobDraftStore.getState().reset();
    expect(useNewJobDraftStore.getState().draft.file).toBeNull();
    expect(useNewJobDraftStore.getState().draft.step).toBe(1);
  });

  it('is cleared when the user logs out, so the next user in this tab never inherits a draft', () => {
    useNewJobDraftStore.getState().patch({ file: new File(['x'], 'a.docx'), project: 'P' });
    useAuthStore.getState().logout();
    expect(useNewJobDraftStore.getState().draft).toEqual(EMPTY_DRAFT);
  });
});
