import { create } from 'zustand';
import type { KbCitation } from '../components/KbCitationChips';
import type { FigureDescriptionEntry } from '../components/FigureDescriptions';
import type { WarningRecord } from '../utils/warnings';

export interface JobSummary {
  id: string;
  mode: string;
  status: string;
  areaPath: string;
  originalFilename: string;
  itemCount: number;
  createdItemCount: number;
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
  // count) -- distinct from per-node quality/grounding signals. `string`
  // is the back-compat seam: a job persisted before the structured-warnings
  // migration still has a literal string[] here -- see utils/warnings.ts's
  // normalizeWarning for where that legacy shape gets reclassified.
  warnings?: (WarningRecord | string)[];
  // Persisted vision-model figure captions (see Job.figureDescriptions'
  // schema.prisma doc comment) -- lets JobDetail's FigureDescriptions panel
  // survive a reload or reopening a completed job, seeding the same
  // figureCaptionsByIndex state live SSE narration otherwise fills in
  // during a run.
  figureDescriptions?: FigureDescriptionEntry[];
  createdAt: string;
  areaPath: string;
  // Both real Job columns (schema.prisma), already present on every GET
  // /jobs/:id response body -- were simply never declared here, so
  // JobDetail.tsx had no typed way to read them and never wired them into
  // DestinationBar, which rendered the hatched "not set" pattern and a bare
  // "—" for every job regardless of what was actually configured.
  iterationPath?: string | null;
  state?: string;
  originalFilename: string;
  // Resolved entirely server-side (real ADO type discovery + icon bytes,
  // see WorkItemTypeCatalogService) and embedded directly in this response
  // -- no separate frontend request needed. {} when there's no diff yet, no
  // vaulted ADO credential, or the resolve itself failed; WorkItemTypeBadge
  // falls back to its own hardcoded color/icon map in that case.
  workItemTypeCatalog?: Record<string, { color: string; iconDataUrl: string }>;
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
