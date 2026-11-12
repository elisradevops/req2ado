import { beforeEach, describe, expect, it, vi } from 'vitest';

// The store reads localStorage once at import, so each test imports a fresh copy.
async function freshStore() {
  vi.resetModules();
  return (await import('./uiPreferencesStore')).useUiPreferencesStore;
}

describe('uiPreferencesStore: the rail', () => {
  beforeEach(() => localStorage.clear());

  it('starts open', async () => {
    const store = await freshStore();

    expect(store.getState().railCollapsed).toBe(false);
  });

  it('remembers a collapsed rail across a reload', async () => {
    const first = await freshStore();
    first.getState().setRailCollapsed(true);

    const second = await freshStore();

    expect(second.getState().railCollapsed).toBe(true);
  });

  it('keeps the other preferences when the rail changes, and the rail when they do', async () => {
    const store = await freshStore();
    store.getState().setDenseView(true);
    store.getState().setRailCollapsed(true);
    store.getState().setKeyboardShortcuts(false);

    const reloaded = await freshStore();

    expect(reloaded.getState()).toMatchObject({ denseView: true, railCollapsed: true, keyboardShortcuts: false, autoSyncLedgers: true });
  });

  it('opens when what was stored cannot be read, instead of failing', async () => {
    localStorage.setItem('req2ado-ui-preferences', '{not json');

    const store = await freshStore();

    expect(store.getState().railCollapsed).toBe(false);
  });
});
