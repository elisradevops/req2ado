import { describe, it, expect, beforeEach } from 'vitest';
import { useAuthStore, loadFromSessionStorage } from './authStore';
import { usePageLabelStore } from './pageLabelStore';

const STORAGE_KEY = 'req2ado-auth-v2';
const LEGACY_V1_STORAGE_KEY = 'req2ado-auth';

describe('authStore', () => {
  beforeEach(() => {
    sessionStorage.clear();
    useAuthStore.getState().logout();
  });

  it('login populates state and mirrors to sessionStorage -- never the PAT, which is vaulted server-side', () => {
    useAuthStore.getState().login('https://ado.example', 'Jane Doe', 'user-descriptor-1');
    const state = useAuthStore.getState();
    expect(state.orgUrl).toBe('https://ado.example');
    expect(state.displayName).toBe('Jane Doe');
    expect(state.userId).toBe('user-descriptor-1');
    expect(JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? '{}')).toEqual({
      orgUrl: 'https://ado.example',
      displayName: 'Jane Doe',
      userId: 'user-descriptor-1',
    });
  });

  it('logout forgets the job file names the breadcrumb learned', () => {
    usePageLabelStore.getState().setJobLabel('job-1', 'customer-spec.docx');
    useAuthStore.getState().logout();
    expect(usePageLabelStore.getState().jobLabels).toEqual({});
  });

  it('logout clears state and sessionStorage', () => {
    useAuthStore.getState().login('https://ado.example', 'Jane Doe', 'user-descriptor-1');
    useAuthStore.getState().logout();
    expect(useAuthStore.getState().orgUrl).toBeNull();
    expect(useAuthStore.getState().userId).toBeNull();
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('loadFromSessionStorage handles malformed JSON gracefully', () => {
    sessionStorage.setItem(STORAGE_KEY, 'not valid json{{{');
    const result = loadFromSessionStorage();
    expect(result.orgUrl).toBeNull();
    expect(result.displayName).toBeNull();
    expect(result.userId).toBeNull();
  });

  it('scrubs a legacy v1 record (which held the PAT in plaintext) from sessionStorage on load', () => {
    sessionStorage.setItem(LEGACY_V1_STORAGE_KEY, JSON.stringify({ orgUrl: 'https://ado.example', pat: 'leaked-pat', displayName: 'Jane', userId: 'u1' }));
    loadFromSessionStorage();
    expect(sessionStorage.getItem(LEGACY_V1_STORAGE_KEY)).toBeNull();
  });

  it('keeps the e-mail and account name given at sign-in, across a reload, and forgets them on logout', () => {
    useAuthStore.getState().login('https://ado.example', 'Jane Doe', 'user-descriptor-1', { email: 'jane@corp.example', accountName: 'CORP\\jane' });

    expect(useAuthStore.getState()).toMatchObject({ email: 'jane@corp.example', accountName: 'CORP\\jane' });
    expect(loadFromSessionStorage()).toMatchObject({ email: 'jane@corp.example', accountName: 'CORP\\jane' });

    useAuthStore.getState().logout();
    expect(useAuthStore.getState()).toMatchObject({ email: null, accountName: null });
  });

  it('has no e-mail or account name for a session stored before they were kept', () => {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ orgUrl: 'https://ado.example', displayName: 'Jane Doe', userId: 'user-descriptor-1' }));

    expect(loadFromSessionStorage()).toMatchObject({ email: null, accountName: null });
  });
});
