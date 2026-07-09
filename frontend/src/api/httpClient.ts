import axios from 'axios';
import { loadRuntimeConfig } from './config';

/** Base axios instance for the orchestrator API. PAT/org-url are attached per-request by callers — never stored here. */
export const httpClient = axios.create();

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
    }
    return Promise.reject(error);
  },
);
