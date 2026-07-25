import { create } from 'zustand';

const STORAGE_KEY = 'req2ado-auth';

interface AuthState {
  orgUrl: string | null;
  pat: string | null;
  displayName: string | null;
  // The logged-in user's stable ADO identity (authenticatedUser.descriptor,
  // see AdoPatProvider/auth.controller.ts) -- the Knowledge Base scope key.
  // Not a secret (safe to cache client-side and resend per-request, same
  // lifecycle as displayName), unlike pat.
  userId: string | null;
  login: (orgUrl: string, pat: string, displayName: string, userId: string) => void;
  logout: () => void;
}

export function loadFromSessionStorage(): Pick<AuthState, 'orgUrl' | 'pat' | 'displayName' | 'userId'> {
  const raw = sessionStorage.getItem(STORAGE_KEY);
  if (!raw) return { orgUrl: null, pat: null, displayName: null, userId: null };
  try {
    return JSON.parse(raw) as { orgUrl: string; pat: string; displayName: string; userId: string | null };
  } catch {
    return { orgUrl: null, pat: null, displayName: null, userId: null };
  }
}

export const useAuthStore = create<AuthState>((set) => ({
  ...loadFromSessionStorage(),
  login: (orgUrl, pat, displayName, userId) => {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ orgUrl, pat, displayName, userId }));
    set({ orgUrl, pat, displayName, userId });
  },
  logout: () => {
    sessionStorage.removeItem(STORAGE_KEY);
    set({ orgUrl: null, pat: null, displayName: null, userId: null });
  },
}));

export const useOrgUrl = (): string | null => useAuthStore((state) => state.orgUrl);
export const usePat = (): string | null => useAuthStore((state) => state.pat);
export const useDisplayName = (): string | null => useAuthStore((state) => state.displayName);
export const useUserId = (): string | null => useAuthStore((state) => state.userId);
export const useIsAuthenticated = (): boolean => useAuthStore((state) => state.orgUrl !== null && state.pat !== null);
