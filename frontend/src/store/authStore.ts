import { create } from 'zustand';

const STORAGE_KEY = 'req2ado-auth';

interface AuthState {
  orgUrl: string | null;
  pat: string | null;
  displayName: string | null;
  login: (orgUrl: string, pat: string, displayName: string) => void;
  logout: () => void;
}

export function loadFromSessionStorage(): Pick<AuthState, 'orgUrl' | 'pat' | 'displayName'> {
  const raw = sessionStorage.getItem(STORAGE_KEY);
  if (!raw) return { orgUrl: null, pat: null, displayName: null };
  try {
    return JSON.parse(raw) as { orgUrl: string; pat: string; displayName: string };
  } catch {
    return { orgUrl: null, pat: null, displayName: null };
  }
}

export const useAuthStore = create<AuthState>((set) => ({
  ...loadFromSessionStorage(),
  login: (orgUrl, pat, displayName) => {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ orgUrl, pat, displayName }));
    set({ orgUrl, pat, displayName });
  },
  logout: () => {
    sessionStorage.removeItem(STORAGE_KEY);
    set({ orgUrl: null, pat: null, displayName: null });
  },
}));

export const useOrgUrl = (): string | null => useAuthStore((state) => state.orgUrl);
export const usePat = (): string | null => useAuthStore((state) => state.pat);
export const useDisplayName = (): string | null => useAuthStore((state) => state.displayName);
export const useIsAuthenticated = (): boolean => useAuthStore((state) => state.orgUrl !== null && state.pat !== null);
