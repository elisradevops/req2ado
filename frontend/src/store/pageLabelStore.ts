import { create } from 'zustand';

// The header's breadcrumb shows a job by its file name once the job page has loaded it; until then (and for any job the page has not
// opened in this tab) it falls back to the shortened id. Held in memory only: a label is cheap to learn again.
interface PageLabelState {
  jobLabels: Record<string, string>;
  setJobLabel: (jobId: string, label: string) => void;
}

export const usePageLabelStore = create<PageLabelState>((set) => ({
  jobLabels: {},
  setJobLabel: (jobId, label) =>
    set((state) => (state.jobLabels[jobId] === label ? state : { jobLabels: { ...state.jobLabels, [jobId]: label } })),
}));
