import { create } from 'zustand';

interface LlmConnectionState {
  // null = not yet checked this session (RouteGuard fetches once per
  // session on mount). Not persisted to sessionStorage -- unlike authStore's
  // identity fields, this reflects server-side vault state that can change
  // out from under a long-lived tab (e.g. an admin clearing the vault), so
  // it's re-verified fresh every session rather than cached across reloads.
  configured: boolean | null;
  setConfigured: (configured: boolean) => void;
  // Called from authStore.logout() -- a different user logging into the
  // same tab must not inherit the previous user's cached configured state.
  reset: () => void;
}

// Separate from authStore -- login (ADO identity) and Open WebUI connection
// configuration are two independent gates now (RouteGuard.tsx checks both),
// and Settings.tsx needs to flip this the instant a save succeeds so
// RouteGuard stops redirecting away from the page the user is already on
// without a full reload.
export const useLlmConnectionStore = create<LlmConnectionState>((set) => ({
  configured: null,
  setConfigured: (configured) => set({ configured }),
  reset: () => set({ configured: null }),
}));
