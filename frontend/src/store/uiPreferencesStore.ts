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
  // The single-key review shortcuts (J K A R X U E). WCAG 2.1.4 asks for a way to turn them off.
  keyboardShortcuts: boolean;
  // The desktop navigation rail is icon-only. A choice the user made, so it is remembered.
  railCollapsed: boolean;
}

const DEFAULTS: StoredPreferences = { denseView: false, autoSyncLedgers: true, keyboardShortcuts: true, railCollapsed: false };

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
  setKeyboardShortcuts: (value: boolean) => void;
  setRailCollapsed: (value: boolean) => void;
}

function save(state: StoredPreferences): void {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ denseView: state.denseView, autoSyncLedgers: state.autoSyncLedgers, keyboardShortcuts: state.keyboardShortcuts, railCollapsed: state.railCollapsed }),
  );
}

export const useUiPreferencesStore = create<UiPreferencesState>((set, get) => ({
  ...loadFromLocalStorage(),
  setDenseView: (value) => {
    set({ denseView: value });
    save(get());
  },
  setAutoSyncLedgers: (value) => {
    set({ autoSyncLedgers: value });
    save(get());
  },
  setKeyboardShortcuts: (value) => {
    set({ keyboardShortcuts: value });
    save(get());
  },
  setRailCollapsed: (value) => {
    set({ railCollapsed: value });
    save(get());
  },
}));

export function useDenseView(): boolean {
  return useUiPreferencesStore((state) => state.denseView);
}

export function useAutoSyncLedgers(): boolean {
  return useUiPreferencesStore((state) => state.autoSyncLedgers);
}

export function useKeyboardShortcuts(): boolean {
  return useUiPreferencesStore((state) => state.keyboardShortcuts);
}
