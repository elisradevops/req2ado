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

export function rememberJobChoices(userId: string | null, choices: LastJobChoices): void {
  if (!userId) return;
  try {
    localStorage.setItem(KEY_PREFIX + userId, JSON.stringify({ mode: choices.mode, project: choices.project, areaPath: choices.areaPath }));
  } catch {
    // Best effort: a remembered default is a convenience, so a blocked or full store is not worth an error.
  }
}

// Applied only to a wizard nobody has touched in this tab (the empty defaults), so a person who is part-way through, or who came back
// from another page, never has their own choices replaced.
export function withRememberedChoices(draft: NewJobDraft, remembered: LastJobChoices | null): NewJobDraft {
  if (!remembered) return draft;
  const untouched = draft.mode === 'baseline' && draft.project === '' && draft.areaPath === '';
  return untouched ? { ...draft, mode: remembered.mode, project: remembered.project, areaPath: remembered.areaPath } : draft;
}
