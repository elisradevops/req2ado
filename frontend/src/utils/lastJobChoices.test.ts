import { describe, it, expect, beforeEach, vi } from 'vitest';
import { isUntouchedChoices, loadLastJobChoices, loadProjectChoices, rememberJobChoices, withRememberedChoices } from './lastJobChoices';
import { EMPTY_DRAFT, type NewJobDraft } from '../store/newJobDraftStore';

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('lastJobChoices', () => {
  it('remembers the mode, project and area path of a started job, per user', () => {
    rememberJobChoices('user-a', { mode: 'survey', project: 'elisradevops-project', areaPath: 'elisradevops-project\\Customer Requirements' });
    expect(loadLastJobChoices('user-a')).toEqual({
      mode: 'survey', project: 'elisradevops-project', areaPath: 'elisradevops-project\\Customer Requirements',
    });
    expect(loadLastJobChoices('user-b')).toBeNull();
  });

  it('does nothing without a user: the key is per user, and there is no anonymous record', () => {
    rememberJobChoices(null, { mode: 'survey', project: 'p', areaPath: 'p\\a' });
    expect(localStorage.length).toBe(0);
    expect(loadLastJobChoices(null)).toBeNull();
  });

  it('ignores a record that is not the expected shape rather than trusting it', () => {
    localStorage.setItem('req2ado-last-job:user-a', '{"mode":"nonsense","project":5}');
    expect(loadLastJobChoices('user-a')).toBeNull();
    localStorage.setItem('req2ado-last-job:user-a', 'not json');
    expect(loadLastJobChoices('user-a')).toBeNull();
  });

  it('survives storage that throws (private window, blocked site data)', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(loadLastJobChoices('user-a')).toBeNull();
    expect(() => rememberJobChoices('user-a', { mode: 'survey', project: 'p', areaPath: 'p\\a' })).not.toThrow();
  });
});

describe('lastJobChoices per Team Project (B6)', () => {
  it('keeps the last mode and area path of each project, not only of the last job', () => {
    rememberJobChoices('user-a', { mode: 'survey', project: 'Alpha', areaPath: 'Alpha\\Reqs' });
    rememberJobChoices('user-a', { mode: 'baseline', project: 'Beta', areaPath: 'Beta\\Imports' });
    expect(loadProjectChoices('user-a', 'Alpha')).toEqual({ mode: 'survey', areaPath: 'Alpha\\Reqs' });
    expect(loadProjectChoices('user-a', 'Beta')).toEqual({ mode: 'baseline', areaPath: 'Beta\\Imports' });
    // The last job overall is still the one a fresh wizard starts from.
    expect(loadLastJobChoices('user-a')).toEqual({ mode: 'baseline', project: 'Beta', areaPath: 'Beta\\Imports' });
  });

  it('a later job in the same project replaces that project\'s record only', () => {
    rememberJobChoices('user-a', { mode: 'survey', project: 'Alpha', areaPath: 'Alpha\\Reqs' });
    rememberJobChoices('user-a', { mode: 'baseline', project: 'Beta', areaPath: 'Beta\\Imports' });
    rememberJobChoices('user-a', { mode: 'baseline', project: 'Alpha', areaPath: 'Alpha\\Other' });
    expect(loadProjectChoices('user-a', 'Alpha')).toEqual({ mode: 'baseline', areaPath: 'Alpha\\Other' });
    expect(loadProjectChoices('user-a', 'Beta')).toEqual({ mode: 'baseline', areaPath: 'Beta\\Imports' });
  });

  it('is per user', () => {
    rememberJobChoices('user-a', { mode: 'survey', project: 'Alpha', areaPath: 'Alpha\\Reqs' });
    expect(loadProjectChoices('user-b', 'Alpha')).toBeNull();
    expect(loadProjectChoices(null, 'Alpha')).toBeNull();
  });

  it('has nothing for a project never used, or for no project', () => {
    rememberJobChoices('user-a', { mode: 'survey', project: 'Alpha', areaPath: 'Alpha\\Reqs' });
    expect(loadProjectChoices('user-a', 'Gamma')).toBeNull();
    expect(loadProjectChoices('user-a', '')).toBeNull();
  });

  it('reads the record saved before per-project memory existed as the record of its own project (no data loss)', () => {
    localStorage.setItem('req2ado-last-job:user-a', JSON.stringify({ mode: 'survey', project: 'Alpha', areaPath: 'Alpha\\Reqs' }));
    expect(loadProjectChoices('user-a', 'Alpha')).toEqual({ mode: 'survey', areaPath: 'Alpha\\Reqs' });
    expect(loadProjectChoices('user-a', 'Beta')).toBeNull();
  });

  it('ignores a per-project record that is not the expected shape', () => {
    localStorage.setItem('req2ado-last-job-by-project:user-a', JSON.stringify({ Alpha: { mode: 'nonsense', areaPath: 3 } }));
    expect(loadProjectChoices('user-a', 'Alpha')).toBeNull();
    localStorage.setItem('req2ado-last-job-by-project:user-a', 'not json');
    expect(loadProjectChoices('user-a', 'Alpha')).toBeNull();
    // A broken map does not stop the next job from being remembered.
    rememberJobChoices('user-a', { mode: 'survey', project: 'Alpha', areaPath: 'Alpha\\Reqs' });
    expect(loadProjectChoices('user-a', 'Alpha')).toEqual({ mode: 'survey', areaPath: 'Alpha\\Reqs' });
  });

  it('survives storage that throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(loadProjectChoices('user-a', 'Alpha')).toBeNull();
  });
});

describe('isUntouchedChoices', () => {
  it('is true only for the empty defaults', () => {
    expect(isUntouchedChoices({ mode: 'baseline', project: '', areaPath: '' })).toBe(true);
    expect(isUntouchedChoices({ mode: 'survey', project: '', areaPath: '' })).toBe(false);
    expect(isUntouchedChoices({ mode: 'baseline', project: 'p', areaPath: '' })).toBe(false);
  });
});

describe('withRememberedChoices', () => {
  const remembered = { mode: 'survey' as const, project: 'proj', areaPath: 'proj\\Customer Requirements' };

  it('fills a draft nobody has touched in this tab', () => {
    const filled = withRememberedChoices(EMPTY_DRAFT, remembered);
    expect(filled).toMatchObject(remembered);
    expect(filled.step).toBe(1);
  });

  it('leaves a draft the user has already chosen in alone, even if only one thing was chosen', () => {
    const chosen: NewJobDraft = { ...EMPTY_DRAFT, mode: 'baseline', project: 'other', areaPath: '' };
    expect(withRememberedChoices(chosen, remembered)).toBe(chosen);
    const chosenMode: NewJobDraft = { ...EMPTY_DRAFT, mode: 'survey' };
    expect(withRememberedChoices(chosenMode, remembered)).toBe(chosenMode);
  });

  it('with applyMode false (the single-file wizard, D1), fills the destination but keeps the default BASELINE mode', () => {
    const filled = withRememberedChoices(EMPTY_DRAFT, remembered, { applyMode: false });
    expect(filled).toMatchObject({ mode: 'baseline', project: 'proj', areaPath: 'proj\\Customer Requirements' });
    // A draft in progress keeps its own mode, SURVEY included.
    const chosenMode: NewJobDraft = { ...EMPTY_DRAFT, mode: 'survey' };
    expect(withRememberedChoices(chosenMode, remembered, { applyMode: false })).toBe(chosenMode);
  });

  it('changes nothing when nothing was remembered', () => {
    expect(withRememberedChoices(EMPTY_DRAFT, null)).toBe(EMPTY_DRAFT);
  });
});
