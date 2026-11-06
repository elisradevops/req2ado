import { create } from 'zustand';

// The New Batch wizard's work in progress, kept for the life of the tab so that leaving for another page (the sidebar, the
// Knowledge Base) and coming back does not drop the chosen files and destination. In memory only: a File cannot be written
// to sessionStorage, and a reload is an explicit fresh start. Same rules as newJobDraftStore: cleared on a started batch
// and on logout.

export interface BatchJobDraft {
  files: File[];
  mode: 'baseline' | 'survey';
  model: string;
  project: string;
  areaPath: string;
  state: string;
  iterationPath: string;
}

export const EMPTY_BATCH_DRAFT: BatchJobDraft = {
  files: [],
  mode: 'baseline',
  model: '',
  project: '',
  areaPath: '',
  state: '',
  iterationPath: '',
};

interface BatchJobDraftStore {
  draft: BatchJobDraft;
  patch: (changes: Partial<BatchJobDraft>) => void;
  reset: () => void;
}

export const useBatchJobDraftStore = create<BatchJobDraftStore>((set) => ({
  draft: EMPTY_BATCH_DRAFT,
  patch: (changes) => set((s) => ({ draft: { ...s.draft, ...changes } })),
  reset: () => set({ draft: EMPTY_BATCH_DRAFT }),
}));
