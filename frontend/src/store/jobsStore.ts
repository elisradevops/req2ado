import { create } from 'zustand';

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
  kbCitations?: string[];
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
