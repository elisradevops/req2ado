import { create } from 'zustand';
import { useLlmConnectionStore } from './llmConnectionStore';
import { usePageLabelStore } from './pageLabelStore';
import { useNewJobDraftStore } from './newJobDraftStore';
import { useBatchJobDraftStore } from './batchJobDraftStore';
import { clearKbBrowseUrl } from '../utils/kbBrowseUrl';

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
  // What ADO also said about the person at sign-in, for the Profile page; null for a session started before these were kept.
  email: string | null;
  accountName: string | null;
  login: (orgUrl: string, displayName: string, userId: string, details?: { email?: string | null; accountName?: string | null }) => void;
  logout: () => void;
}

export function loadFromSessionStorage(): Pick<AuthState, 'orgUrl' | 'displayName' | 'userId' | 'email' | 'accountName'> {
  // Scrub any pre-vault v1 record -- it held the PAT in plaintext.
  sessionStorage.removeItem(LEGACY_V1_STORAGE_KEY);
  const none = { orgUrl: null, displayName: null, userId: null, email: null, accountName: null };
  const raw = sessionStorage.getItem(STORAGE_KEY);
  if (!raw) return none;
  try {
    const stored = JSON.parse(raw) as { orgUrl: string; displayName: string; userId: string | null; email?: string | null; accountName?: string | null };
    return { orgUrl: stored.orgUrl, displayName: stored.displayName, userId: stored.userId, email: stored.email ?? null, accountName: stored.accountName ?? null };
  } catch {
    return none;
  }
}

export const useAuthStore = create<AuthState>((set) => ({
  ...loadFromSessionStorage(),
  login: (orgUrl, displayName, userId, details) => {
    const email = details?.email ?? null;
    const accountName = details?.accountName ?? null;
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ orgUrl, displayName, userId, ...(email ? { email } : {}), ...(accountName ? { accountName } : {}) }));
    set({ orgUrl, displayName, userId, email, accountName });
  },
  logout: () => {
    // Read before the state is cleared: the folder the signed-in user last browsed is theirs, and goes with them.
    clearKbBrowseUrl(useAuthStore.getState().userId);
    sessionStorage.removeItem(STORAGE_KEY);
    set({ orgUrl: null, displayName: null, userId: null, email: null, accountName: null });
    // A different user logging into the same tab must not inherit the
    // previous user's cached Open WebUI configured state.
    useLlmConnectionStore.getState().reset();
    usePageLabelStore.setState({ jobLabels: {} });
    // ...nor a half-finished New Job or New Batch (they hold the previous user's files).
    useNewJobDraftStore.getState().reset();
    useBatchJobDraftStore.getState().reset();
  },
}));

export const useOrgUrl = (): string | null => useAuthStore((state) => state.orgUrl);
export const useDisplayName = (): string | null => useAuthStore((state) => state.displayName);
export const useUserId = (): string | null => useAuthStore((state) => state.userId);
export const useEmail = (): string | null => useAuthStore((state) => state.email);
export const useAccountName = (): string | null => useAuthStore((state) => state.accountName);
// The httpOnly session cookie is the real auth mechanism (AuthGuard) --
// this locally-cached orgUrl is only a UI signal for "has this browser
// completed login" (which pages to show / which picker mode to render),
// not a security boundary. A request from a genuinely unauthenticated
// browser still 401s server-side regardless of what this returns.
export const useIsAuthenticated = (): boolean => useAuthStore((state) => state.orgUrl !== null);
