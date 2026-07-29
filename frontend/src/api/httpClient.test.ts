import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AxiosError } from 'axios';
import { httpClient } from './httpClient';
import { useAuthStore } from '../store/authStore';

function axiosErrorWithStatusAndUrl(status: number, url: string): AxiosError {
  const error = new AxiosError('Request failed', String(status));
  error.response = { status, data: {}, statusText: '', headers: {}, config: {} as never };
  error.config = { url } as never;
  return error;
}

// axios exposes registered interceptors on `.handlers` -- invoking the
// rejected handler directly is the standard way to exercise interceptor
// logic without standing up a real HTTP round trip.
function runResponseRejectedInterceptor(error: AxiosError): Promise<unknown> {
  const rejectedHandler = (httpClient.interceptors.response as unknown as { handlers: { rejected: (e: unknown) => unknown }[] }).handlers[0]
    .rejected;
  return Promise.resolve(rejectedHandler(error)).catch((e) => {
    throw e;
  });
}

describe('httpClient response interceptor', () => {
  beforeEach(() => {
    useAuthStore.getState().login('https://ado.example', 'Jane', 'user-descriptor-1');
    vi.stubGlobal('location', { assign: vi.fn() });
  });

  it('clears auth state and redirects to /login on a 401 from a non-login route', async () => {
    await expect(runResponseRejectedInterceptor(axiosErrorWithStatusAndUrl(401, '/jobs'))).rejects.toThrow();

    expect(useAuthStore.getState().orgUrl).toBeNull();
    expect(window.location.assign).toHaveBeenCalledWith('/login');
  });

  it('does not clear auth state or redirect on a 401 from /auth/login itself (a wrong-credential attempt)', async () => {
    await expect(runResponseRejectedInterceptor(axiosErrorWithStatusAndUrl(401, '/auth/login'))).rejects.toThrow();

    expect(useAuthStore.getState().orgUrl).toBe('https://ado.example');
    expect(window.location.assign).not.toHaveBeenCalled();
  });

  it('does not redirect on a non-401 error status', async () => {
    await expect(runResponseRejectedInterceptor(axiosErrorWithStatusAndUrl(500, '/jobs'))).rejects.toThrow();

    expect(useAuthStore.getState().orgUrl).toBe('https://ado.example');
    expect(window.location.assign).not.toHaveBeenCalled();
  });

  it('does not clear auth state or redirect on a 424 from /kb/browse-folder -- a downstream SharePoint token expiry, not the orchestrator session', async () => {
    // Regression guard for a confirmed real bug (user-reported: "why am I
    // getting logged out when I try to access the Knowledge Base page?"):
    // the KB page auto-restores its last-browsed SharePoint folder on
    // mount, and a real, expected SharePoint-token expiry (~1h TTL) used to
    // reach the frontend as a bare 401 (kb.controller.ts re-threw
    // ingestion's own 401 as-is), tripping THIS interceptor and force-
    // logging the user out of the whole app over an expired SharePoint
    // token, not an expired orchestrator session. The orchestrator now
    // remaps that specific case to 424 (see mapIngestionErrorStatus) --
    // this locks in that only a REAL 401 clears the session.
    await expect(runResponseRejectedInterceptor(axiosErrorWithStatusAndUrl(424, '/kb/browse-folder'))).rejects.toThrow();

    expect(useAuthStore.getState().orgUrl).toBe('https://ado.example');
    expect(window.location.assign).not.toHaveBeenCalled();
  });
});
