import { create } from 'zustand';

// v2: the PAT is no longer held here at all -- the orchestrator vaults it
// server-side (credential-vault.service.ts) at login/reconnect time and
// resolves it per-request from the session cookie, so there is nothing
// left for the browser to resend. v1's sessionStorage record (which DID
// hold the PAT in plaintext) is actively scrubbed on load below rather
// than just left stale, since a lingering v1 key would otherwise sit in
// sessionStorage indefinitely holding a real secret.
const STORAGE_KEY = 'req2ado-auth-v2';
const LEGACY_V1_STORAGE_KEY = 'req2ado-auth';

interface AuthState {
  orgUrl: string | null;
  displayName: string | null;
  // The logged-in user's stable ADO identity (authenticatedUser.descriptor,
  // see AdoPatProvider/auth.controller.ts) -- the Knowledge Base scope key.
  // Not a secret (safe to cache client-side), unlike the PAT.
  userId: string | null;
  login: (orgUrl: string, displayName: string, userId: string) => void;
  logout: () => void;
}

export function loadFromSessionStorage(): Pick<AuthState, 'orgUrl' | 'displayName' | 'userId'> {
  // Scrub any pre-vault v1 record -- it held the PAT in plaintext.
  sessionStorage.removeItem(LEGACY_V1_STORAGE_KEY);
  const raw = sessionStorage.getItem(STORAGE_KEY);
  if (!raw) return { orgUrl: null, displayName: null, userId: null };
  try {
    return JSON.parse(raw) as { orgUrl: string; displayName: string; userId: string | null };
  } catch {
    return { orgUrl: null, displayName: null, userId: null };
  }
}

export const useAuthStore = create<AuthState>((set) => ({
  ...loadFromSessionStorage(),
  login: (orgUrl, displayName, userId) => {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ orgUrl, displayName, userId }));
    set({ orgUrl, displayName, userId });
  },
  logout: () => {
    sessionStorage.removeItem(STORAGE_KEY);
    set({ orgUrl: null, displayName: null, userId: null });
  },
}));

export const useOrgUrl = (): string | null => useAuthStore((state) => state.orgUrl);
export const useDisplayName = (): string | null => useAuthStore((state) => state.displayName);
export const useUserId = (): string | null => useAuthStore((state) => state.userId);
// The httpOnly session cookie is the real auth mechanism (AuthGuard) --
// this locally-cached orgUrl is only a UI signal for "has this browser
// completed login" (which pages to show / which picker mode to render),
// not a security boundary. A request from a genuinely unauthenticated
// browser still 401s server-side regardless of what this returns.
export const useIsAuthenticated = (): boolean => useAuthStore((state) => state.orgUrl !== null);
