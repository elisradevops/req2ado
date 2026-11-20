import type { NewJobDraft } from '../store/newJobDraftStore';

// What the person chose for the last job they started (mode, project, area path), so the next one starts from there: the team's
// mode and destination rarely change from one upload to the next, and re-picking them cost three controls a day. A per-viewer
// convenience only: in localStorage under the user's own key, never required, never shared, and every read and write is guarded,
// since storage can be blocked or throw. Nothing here is a secret.
export interface LastJobChoices {
  mode: 'baseline' | 'survey';
  project: string;
  areaPath: string;
}

const KEY_PREFIX = 'req2ado-last-job:';
// The same choices kept per Team Project ({ [project]: { mode, areaPath } }), so picking a project offers that project's own last area path and
// mode, not those of whichever project was used last. The single record above stays the last job overall (what a fresh wizard starts from), and
// is read as the record of its own project, so nothing saved before this map existed is lost.
const BY_PROJECT_KEY_PREFIX = 'req2ado-last-job-by-project:';

export interface ProjectJobChoices {
  mode: 'baseline' | 'survey';
  areaPath: string;
}

function isChoices(value: unknown): value is LastJobChoices {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (record.mode === 'baseline' || record.mode === 'survey') && typeof record.project === 'string' && typeof record.areaPath === 'string';
}

export function loadLastJobChoices(userId: string | null): LastJobChoices | null {
  if (!userId) return null;
  try {
    const raw = localStorage.getItem(KEY_PREFIX + userId);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isChoices(parsed) ? { mode: parsed.mode, project: parsed.project, areaPath: parsed.areaPath } : null;
  } catch {
    return null;
  }
}

function isProjectChoices(value: unknown): value is ProjectJobChoices {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (record.mode === 'baseline' || record.mode === 'survey') && typeof record.areaPath === 'string';
}

function loadByProject(userId: string): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(BY_PROJECT_KEY_PREFIX + userId);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function loadProjectChoices(userId: string | null, project: string): ProjectJobChoices | null {
  if (!userId || !project) return null;
  const record = loadByProject(userId)[project];
  if (isProjectChoices(record)) return { mode: record.mode, areaPath: record.areaPath };
  const last = loadLastJobChoices(userId);
  return last && last.project === project ? { mode: last.mode, areaPath: last.areaPath } : null;
}

export function rememberJobChoices(userId: string | null, choices: LastJobChoices): void {
  if (!userId) return;
  try {
    localStorage.setItem(KEY_PREFIX + userId, JSON.stringify({ mode: choices.mode, project: choices.project, areaPath: choices.areaPath }));
    if (choices.project) {
      const byProject = loadByProject(userId);
      byProject[choices.project] = { mode: choices.mode, areaPath: choices.areaPath };
      localStorage.setItem(BY_PROJECT_KEY_PREFIX + userId, JSON.stringify(byProject));
    }
  } catch {
    // Best effort: a remembered default is a convenience, so a blocked or full store is not worth an error.
  }
}

// The empty defaults of a wizard nobody has chosen anything in.
export function isUntouchedChoices(draft: Pick<LastJobChoices, 'mode' | 'project' | 'areaPath'>): boolean {
  return draft.mode === 'baseline' && draft.project === '' && draft.areaPath === '';
}

// Applied only to a wizard nobody has touched in this tab (the empty defaults), so a person who is part-way through, or who came back
// from another page, never has their own choices replaced. `applyMode: false` restores the destination only and leaves the mode at its
// default (the single-file wizard: BASELINE is always preselected, since a remembered SURVEY spends model tokens nobody chose this time).
export function withRememberedChoices<T extends Pick<NewJobDraft, 'mode' | 'project' | 'areaPath'>>(
  draft: T,
  remembered: LastJobChoices | null,
  { applyMode = true }: { applyMode?: boolean } = {},
): T {
  if (!remembered || !isUntouchedChoices(draft)) return draft;
  return { ...draft, ...(applyMode ? { mode: remembered.mode } : {}), project: remembered.project, areaPath: remembered.areaPath };
}
