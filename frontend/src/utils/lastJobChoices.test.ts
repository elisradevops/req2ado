import { describe, it, expect, beforeEach, vi } from 'vitest';
import { loadLastJobChoices, rememberJobChoices, withRememberedChoices } from './lastJobChoices';
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

  it('changes nothing when nothing was remembered', () => {
    expect(withRememberedChoices(EMPTY_DRAFT, null)).toBe(EMPTY_DRAFT);
  });
});
