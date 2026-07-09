import { describe, it, expect, beforeEach } from 'vitest';
import { useAuthStore } from './authStore';

describe('authStore', () => {
  beforeEach(() => {
    sessionStorage.clear();
    useAuthStore.getState().logout();
  });

  it('login populates state and mirrors to sessionStorage', () => {
    useAuthStore.getState().login('https://ado.example', 'pat-abc', 'Jane Doe');
    const state = useAuthStore.getState();
    expect(state.orgUrl).toBe('https://ado.example');
    expect(state.pat).toBe('pat-abc');
    expect(state.displayName).toBe('Jane Doe');
    expect(JSON.parse(sessionStorage.getItem('req2ado-auth') ?? '{}')).toEqual({
      orgUrl: 'https://ado.example',
      pat: 'pat-abc',
      displayName: 'Jane Doe',
    });
  });

  it('logout clears state and sessionStorage', () => {
    useAuthStore.getState().login('https://ado.example', 'pat-abc', 'Jane Doe');
    useAuthStore.getState().logout();
    expect(useAuthStore.getState().orgUrl).toBeNull();
    expect(sessionStorage.getItem('req2ado-auth')).toBeNull();
  });
});
