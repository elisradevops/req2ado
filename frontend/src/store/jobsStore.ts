import { create } from 'zustand';
import type { KbCitation } from '../components/KbCitationChips';

export interface JobSummary {
  id: string;
  mode: string;
  status: string;
  areaPath: string;
  itemCount: number;
  createdAt: string;
}

export interface JobDetail {
  id: string;
  status: string;
  mode: string;
  dryRunDiff: unknown;
  kbCitations?: KbCitation[];
  // Tree-level integrity warnings from ingestion's /level response
  // (SURVEY-only, e.g. generated node count diverging from source block
  // count) -- distinct from per-node quality/grounding signals.
  warnings?: string[];
  createdAt: string;
}

interface JobsState {
  jobs: JobSummary[];
  jobDetailCache: Record<string, JobDetail>;
  setJobs: (jobs: JobSummary[]) => void;
  setJobDetail: (id: string, detail: JobDetail) => void;
}

export const useJobsStore = create<JobsState>((set) => ({
  jobs: [],
  jobDetailCache: {},
  setJobs: (jobs) => set({ jobs }),
  setJobDetail: (id, detail) => set((state) => ({ jobDetailCache: { ...state.jobDetailCache, [id]: detail } })),
}));

export const useJobs = (): JobSummary[] => useJobsStore((state) => state.jobs);
export const useJobDetail = (id: string): JobDetail | undefined => useJobsStore((state) => state.jobDetailCache[id]);
