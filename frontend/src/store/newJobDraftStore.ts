import { create } from 'zustand';
import type { FileDropzoneStatus } from '../components/FileDropzone';
import type { PreviewResult } from '../api/jobs';

// The New Job wizard's work in progress, kept for the life of the tab so that leaving for another page (the Knowledge Base
// to fix a file, say) and coming back does not send the user to step 1 to upload and choose everything again. In memory
// only, on purpose: a File cannot be written to sessionStorage, and a reload is an explicit fresh start. It holds what the
// user chose or what was parsed from their file; anything derivable (estimates, the model list, the AI summary) is
// fetched again by the wizard. Cleared on a started job, a replaced file and logout.

export interface NewJobDraft {
  step: 1 | 2 | 3;
  file: File | null;
  preview: PreviewResult | null;
  parseStatus: FileDropzoneStatus;
  mode: 'baseline' | 'survey';
  model: string;
  project: string;
  areaPath: string;
  state: string;
  iterationPath: string;
}

export const EMPTY_DRAFT: NewJobDraft = {
  step: 1,
  file: null,
  preview: null,
  parseStatus: 'idle',
  mode: 'baseline',
  model: '',
  project: '',
  areaPath: '',
  state: '',
  iterationPath: '',
};

interface NewJobDraftStore {
  draft: NewJobDraft;
  patch: (changes: Partial<NewJobDraft>) => void;
  reset: () => void;
}

export const useNewJobDraftStore = create<NewJobDraftStore>((set) => ({
  draft: EMPTY_DRAFT,
  patch: (changes) => set((s) => ({ draft: { ...s.draft, ...changes } })),
  reset: () => set({ draft: EMPTY_DRAFT }),
}));

/**
 * The draft as the wizard should start from it. A parse that was still running (or had failed) when the user left has no
 * result that can arrive any more, so the file side is dropped and the wizard starts at the dropzone rather than showing
 * a spinner that never ends; the choices the user made (mode, project, ...) are kept either way.
 */
export function restorableDraft(): NewJobDraft {
  const { draft } = useNewJobDraftStore.getState();
  if (draft.file && draft.preview && draft.parseStatus === 'parsed') return draft;
  return { ...draft, file: null, preview: null, parseStatus: 'idle', step: 1 };
}
