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
  // Set only for a job submitted as part of a batch (NEW-05) -- lets
  // JobsList render a "Batch" chip linking back to the batch's status page.
  batchId?: string | null;
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
  // Persisted table captions (see Job.tableDescriptions' schema.prisma doc
  // comment) -- lets a "Table tN" chip (NodeDetailPanel.tsx) show a readable
  // title instead of the raw internal id. Keyed by the table's own id, not
  // an array position -- unlike figureDescriptions there is no live-SSE
  // narration counterpart to reconcile with (tables are never narrated
  // figure-by-figure), so this is the only source for it.
  tableDescriptions?: { tableId: string; caption: string }[];
  // Figures/tables STAGE 2 mapping (see ingestion's
  // _map_figures_tables_to_nodes) judged decorative/irrelevant rather than
  // attaching to any node -- a real, named category, NOT an exhaustive
  // accounting: a table dropped for EMPTY_TABLE_CONTENT (a separate,
  // pre-existing warning) lands in neither a node's table_ids nor here.
  // Optional/defaulted to [] server-side for a job persisted before this
  // column existed.
  excludedFigureIds?: string[];
  excludedTableIds?: string[];
  // Generated once in the New Job Wizard's SURVEY-only "Confirm
  // understanding" step, before this Job existed -- see Job.documentOverview's
  // schema.prisma doc comment. Null for BASELINE (never attempted, an
  // explicit mode-driven state, see JobDetail.tsx's DocumentOverviewCard)
  // or a SURVEY job whose generation call failed at wizard time. Optional,
  // like excludedFigureIds/tableDescriptions/iterationPath above, for a job
  // persisted before this column existed -- JobDetail.tsx already reads it
  // via `job.documentOverview ?? null`.
  documentOverview?: { synopsis: string; caveat: string | null } | null;
  createdAt: string;
  areaPath: string;
  // The ADO project this job writes into (Job.adoProject) -- lets
  // JobDetail.tsx read the real column instead of re-deriving it from
  // areaPath client-side. Optional/nullable: a historical job the backfill
  // migration somehow missed.
  adoProject?: string | null;
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
  // Category ('Epic'/'Feature'/'Requirement', the internal label
  // DryRunDiffEntry.type is always stored as) -> this project's real ADO
  // type name, for DISPLAY LABELS only -- see
  // WorkItemTypeCatalogService.resolveCategoryLabels's own doc comment.
  // Defaults (server-side) to the identity map, never undefined here once a
  // job has a diff.
  workItemTypeCategoryLabels?: Record<'Epic' | 'Feature' | 'Requirement', string>;
  // The SAME field (and its real allowedValues) JobsService.confirm() will
  // actually write a Requirement's classification to -- see
  // WorkItemTypeCatalogService.resolveRequirementClassificationField's own
  // doc comment. null/undefined in the same cases workItemTypeCatalog is {}.
  requirementClassificationField?: { referenceName: string; allowedValues: string[] } | null;
  // Task 4: JobTraceLinkFailure rows (see orchestrator's JobsService.getById
  // own doc comment) -- lets TraceLinkChips render a link whose write to
  // Azure DevOps actually failed distinctly from an ordinary resolved/
  // unresolved link, and offer a retry (retryTraceLinkWrite, api/jobs.ts).
  // `id` is this row's own id, needed to call the retry endpoint.
  traceLinkFailures?: TraceLinkFailure[];
  // Count of durable CreatedItemMapping rows (see orchestrator's
  // JobsService.getById own doc comment) -- nonzero on a 'diff_ready' job
  // means a prior confirm() attempt already wrote some items before
  // failing partway through. Lets JobDetail show this before a resumed
  // Confirm click, instead of a blind re-submit.
  createdItemCount?: number;
}

export interface TraceLinkFailure {
  id: string;
  sourceLocalId: string;
  sourceAdoId: number;
  targetAdoId: number;
  referenceName: string;
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
