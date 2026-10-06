import type { Notice, ProgressEvent, ProgressUnit, StageName } from '../api/liveTypes';

// Copy for the live run view. Owned by the frontend (never sent by the server)
// so tone stays in one place and no server text can carry document content.
// Sentence case, name things by what the user controls, never fabricate a
// number (DESIGN.md section 12).

export interface StageCopy {
  /** What the run is doing, as a short headline. */
  headline: string;
  /** Why it is doing it, one sentence. */
  why: string;
}

export const STAGE_COPY: Record<StageName, StageCopy> = {
  parse: {
    headline: 'Reading the document',
    why: 'The file is split into headings, tables and figures before any model sees it.',
  },
  draft: {
    headline: 'Rewriting fragments as requirements',
    why: 'Short table cells and headings are turned into complete requirement statements.',
  },
  improve: {
    headline: 'Writing titles and tags',
    why: 'Each requirement gets a short title and tags so it is easy to scan and group.',
  },
  summarize: {
    headline: 'Summarizing epics and features',
    why: 'Each group gets a title and a short description of what its requirements deliver together.',
  },
  skeleton: {
    headline: 'Planning work items',
    why: 'The model decides which epics, features and requirements the remaining text needs.',
  },
  map: {
    headline: 'Attaching figures and tables',
    why: 'Each figure and table is linked to the work item that describes it.',
  },
  write: {
    headline: 'Writing requirement text',
    why: 'Each section is written separately so the model can focus on it.',
  },
  score: {
    headline: 'Checking requirement wording',
    why: 'Each requirement is checked for clear, testable wording. Low scores are flagged for your review.',
  },
  link: {
    headline: 'Linking related requirements',
    why: 'Near-duplicates are compared for values that disagree, and requirements that cover each other are linked.',
  },
  dedup: {
    headline: 'Checking for duplicates',
    why: 'Each proposed item is compared with work items already in Azure DevOps so nothing is created twice.',
  },
  write_ado: {
    headline: 'Writing to Azure DevOps',
    why: 'The approved items are being created.',
  },
};

const UNIT_NAMES: Record<ProgressUnit, [string, string]> = {
  figures: ['figure', 'figures'],
  pages: ['page', 'pages'],
  items: ['item', 'items'],
  sections: ['section', 'sections'],
  requirements: ['requirement', 'requirements'],
  passes: ['pass', 'passes'],
};

export function unitName(unit: ProgressUnit, count: number): string {
  const [one, many] = UNIT_NAMES[unit];
  return count === 1 ? one : many;
}

export const formatCount = (value: number): string => value.toLocaleString('en-US');

/** "12 of 36 items" -- or null when the step has no real total to count against. */
export function describeStepCount(progress: Pick<ProgressEvent, 'done' | 'total' | 'unit'>): string | null {
  if (progress.total <= 0) return null;
  const done = Math.min(progress.done, progress.total);
  return `${formatCount(done)} of ${formatCount(progress.total)} ${unitName(progress.unit, progress.total)}`;
}

/** The line under the percentage when it is counted from real units. */
export function describeCountedProgress(progress: ProgressEvent): string {
  const step = describeStepCount(progress);
  const share = progress.estimated ? ' (est.)' : '';
  return step
    ? `${progress.pct}% of the run${share} — ${step} in this step`
    : `${progress.pct}% of the run${share}`;
}

export function describeCountedValueText(progress: ProgressEvent): string {
  return `${progress.pct} percent of the run${progress.estimated ? ', estimated' : ''}`;
}

export const COUNTED_EXPLANATION =
  'The percentage is counted from the items each step has finished. How much of the whole run each step takes is an ' +
  'estimate, so the number can move in uneven steps and is marked est.';

export const EXCERPT_EXPLANATION =
  'A short excerpt of your own document, shown while the model works on that part. It is not stored.';

export function formatIdle(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  if (minutes === 0) return `${rest}s`;
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}

export const CONNECTION_LOST_COPY = 'Connection lost — reconnecting. The run keeps going on the server.';
export const WAITING_ON_MODEL_COPY = (idleSeconds: number): string =>
  `Still working — the model has been answering one long request for ${formatIdle(idleSeconds)}.`;
export const NO_ACTIVE_WORK_COPY = "Waiting for the model's next answer.";
export const STALE_WORK_COPY = 'Still waiting on the model for this step.';
export const OUTLINE_TRUNCATED_COPY = 'Showing the first part of the outline. The run still covers the whole document.';

export const itemTypeLabel = (type: string | null | undefined): string | null => (type ? type : null);

/**
 * A name a reader can use for an item the run mentions: the title the run sent,
 * else the heading from the document map, else nothing. Internal ids (the run's
 * node ids, or the matched item's store id) are never shown (DESIGN.md section 12).
 */
export function readableTitle(
  title: string | null | undefined,
  ref: string | null | undefined,
  titleByRef?: ReadonlyMap<string, string>,
): string | null {
  const own = title?.trim();
  if (own) return own;
  const fromMap = ref ? titleByRef?.get(ref)?.trim() : undefined;
  return fromMap || null;
}

export const UNKNOWN_ITEM_COPY = 'an item';

export interface CompareSideLabel {
  /** Shown above the text. */
  label: string;
  /** The side's accessible name. */
  name: string;
}

/** What to call each side of a comparison. A work item in Azure DevOps is named by its number. */
export function compareSideLabel(
  kind: 'conflict' | 'duplicate',
  which: 'a' | 'b',
  ref: string,
  titleByRef?: ReadonlyMap<string, string>,
): CompareSideLabel {
  if (kind === 'duplicate') {
    if (which === 'a') return { label: 'Proposed item', name: 'Proposed item' };
    const adoId = /^\d+$/.test(ref) ? ref : null;
    const label = adoId ? `Existing work item ${adoId}` : 'Existing work item';
    return { label, name: label };
  }
  const title = readableTitle(null, ref, titleByRef);
  const fallback = which === 'a' ? 'First statement' : 'Second statement';
  return { label: title ?? fallback, name: title ? `Statement: ${title}` : fallback };
}

export const LIMITS_HEADING = 'Limits and adjustments';
export const RUN_SUMMARY_HEADING = 'How this run went';

export interface NoticeCopy {
  title: string;
  /** Cause first, then what the reader can do about it. */
  detail: string;
}

const timesLine = (count: number): string => (count > 1 ? ` This happened ${count} times.` : '');

/**
 * What to say about a notice. The server sends a kind and a few numbers, never
 * text, so the wording lives here (and internal ids never reach the reader).
 */
export function noticeCopy(
  notice: Pick<Notice, 'kind' | 'count' | 'facts'>,
  titleByRef?: ReadonlyMap<string, string>,
): NoticeCopy {
  const { kind, count, facts } = notice;
  switch (kind) {
    case 'output_limit_reached': {
      const last = typeof facts.lastRef === 'string' ? readableTitle(null, facts.lastRef, titleByRef) : null;
      return {
        title: 'The model reached its output limit',
        detail:
          `The model stopped writing before it finished a response, so some parts may be incomplete.` +
          (last ? ` The last item it finished was "${last}".` : '') +
          timesLine(count) +
          ' Check those parts in the review, or run again with a model that allows longer answers.',
      };
    }
    case 'server_retry': {
      const status = typeof facts.status === 'number' ? ` (status ${facts.status})` : '';
      return {
        title: 'The model server was busy',
        detail:
          `The model server returned an error${status} and the request was sent again.` +
          timesLine(count) +
          ' Repeated errors make the run slower. If they keep coming, check that the model server is healthy.',
      };
    }
    case 'context_assumed': {
      const tokens = typeof facts.tokens === 'number' ? ` of ${facts.tokens.toLocaleString('en-US')} tokens` : '';
      return {
        title: 'Context size assumed',
        detail:
          `This model did not report how much text it can read at once, so the run assumed a window${tokens}. ` +
          'If the model can read more, the document is split into more parts than it needs to be.',
      };
    }
    case 'stream_fallback':
      return {
        title: 'Live writing preview unavailable for some steps',
        detail:
          'For some steps the model answered all at once instead of streaming, so the writing preview skipped them. ' +
          'The result is the same.' +
          timesLine(count),
      };
  }
}
