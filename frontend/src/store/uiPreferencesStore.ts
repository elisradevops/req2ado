import { create } from 'zustand';

// Two real, working preferences (DESIGN.md Track B, phase B11) -- not
// decorative toggles: denseView actually tightens JobsList's table padding,
// autoSyncLedgers actually gates a background poll of GET /jobs. Persisted
// the same manual localStorage way authStore/KnowledgeBase.tsx already do
// (this app has no zustand `persist` middleware usage to match instead) --
// a UI preference, not a secret, so plain localStorage (survives restarts)
// is fine, unlike authStore's session-scoped sessionStorage.
const STORAGE_KEY = 'req2ado-ui-preferences';

interface StoredPreferences {
  denseView: boolean;
  autoSyncLedgers: boolean;
}

const DEFAULTS: StoredPreferences = { denseView: false, autoSyncLedgers: true };

function loadFromLocalStorage(): StoredPreferences {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return DEFAULTS;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredPreferences>;
    return { ...DEFAULTS, ...parsed };
  } catch {
    return DEFAULTS;
  }
}

interface UiPreferencesState extends StoredPreferences {
  setDenseView: (value: boolean) => void;
  setAutoSyncLedgers: (value: boolean) => void;
}

export const useUiPreferencesStore = create<UiPreferencesState>((set, get) => ({
  ...loadFromLocalStorage(),
  setDenseView: (value) => {
    set({ denseView: value });
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ denseView: value, autoSyncLedgers: get().autoSyncLedgers }));
  },
  setAutoSyncLedgers: (value) => {
    set({ autoSyncLedgers: value });
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ denseView: get().denseView, autoSyncLedgers: value }));
  },
}));

export function useDenseView(): boolean {
  return useUiPreferencesStore((state) => state.denseView);
}

export function useAutoSyncLedgers(): boolean {
  return useUiPreferencesStore((state) => state.autoSyncLedgers);
}
