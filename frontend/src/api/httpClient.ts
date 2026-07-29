import axios from 'axios';
import { loadRuntimeConfig } from './config';
import { useAuthStore } from '../store/authStore';

/**
 * Base axios instance for the orchestrator API. PAT/org-url are attached
 * per-request by callers — never stored here. `withCredentials: true` is
 * what actually sends/receives the httpOnly session cookie (auth.guard.ts)
 * -- required for cross-origin dev (Vite on its own port); same-origin
 * production traffic would work either way, but this must be on for dev
 * to function at all.
 */
export const httpClient = axios.create({ withCredentials: true });

httpClient.interceptors.request.use(async (config) => {
  if (!config.baseURL) {
    const runtimeConfig = await loadRuntimeConfig();
    config.baseURL = runtimeConfig.apiBaseUrl;
  }
  return config;
});

httpClient.interceptors.response.use(
  (response) => response,
  (error) => {
    if (!error.response) {
      error.message = 'Network error — check your connection.';
    } else if (error.response.status === 401 && !error.config?.url?.includes('/auth/login')) {
      // The real server session (auth.guard.ts) expired, was revoked, or a
      // redeploy invalidated every open session -- not the same thing as
      // the locally-cached orgUrl/pat, which is why every subsequent call
      // would otherwise 401 forever with no visible explanation. Excludes
      // /auth/login itself: a wrong-credential login attempt legitimately
      // 401s and must not also force-clear/redirect on top of its own
      // error message.
      useAuthStore.getState().logout();
      window.location.assign('/login');
    }
    return Promise.reject(error);
  },
);
