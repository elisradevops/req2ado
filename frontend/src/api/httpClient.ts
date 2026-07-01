import axios from 'axios';

/** Base axios instance for the orchestrator API. PAT/org-url are attached per-request by callers — never stored here. */
export const httpClient = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3001',
});
