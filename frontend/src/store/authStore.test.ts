import { describe, it, expect, beforeEach } from 'vitest';
import { useAuthStore, loadFromSessionStorage } from './authStore';

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
});
