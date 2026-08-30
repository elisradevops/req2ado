import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { Login } from './Login';
import { httpClient } from '../api/httpClient';
import { useAuthStore } from '../store/authStore';

function renderLogin() {
  return render(
    <MemoryRouter initialEntries={['/login']}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/jobs" element={<div>Jobs Page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('Login page', () => {
  beforeEach(() => useAuthStore.getState().logout());
  afterEach(() => vi.restoreAllMocks());

  it('disables the sign-in button until both fields are filled', () => {
    renderLogin();
    expect(screen.getByText('Sign in')).toBeDisabled();
  });

  it('does not render an Azure AD sign-in option', () => {
    renderLogin();
    expect(screen.queryByText(/Azure AD/i)).not.toBeInTheDocument();
  });

  it('calls /auth/login and navigates to /jobs when sign-in succeeds', async () => {
    vi.spyOn(httpClient, 'post').mockResolvedValueOnce({ data: { displayName: 'Jane Doe' } });

    renderLogin();
    fireEvent.change(screen.getByLabelText('ADO Organization URL'), { target: { value: 'https://tfs.internal/tfs/Collection' } });
    fireEvent.change(screen.getByLabelText('Personal Access Token'), { target: { value: 'fake-pat' } });
    fireEvent.click(screen.getByText('Sign in'));

    await waitFor(() => expect(screen.getByText('Jobs Page')).toBeInTheDocument());
    expect(httpClient.post).toHaveBeenCalledWith('/auth/login', {
      adoOrgUrl: 'https://tfs.internal/tfs/Collection',
      pat: 'fake-pat',
    });
  });

  it('populates useAuthStore with the org URL and display name on successful login -- never the PAT, which is vaulted server-side', async () => {
    vi.spyOn(httpClient, 'post').mockResolvedValueOnce({ data: { displayName: 'Jane Doe' } });

    renderLogin();
    fireEvent.change(screen.getByLabelText('ADO Organization URL'), { target: { value: 'https://tfs.internal/tfs/Collection' } });
    fireEvent.change(screen.getByLabelText('Personal Access Token'), { target: { value: 'fake-pat' } });
    fireEvent.click(screen.getByText('Sign in'));

    await waitFor(() => expect(screen.getByText('Jobs Page')).toBeInTheDocument());
    const state = useAuthStore.getState();
    expect(state).toMatchObject({
      orgUrl: 'https://tfs.internal/tfs/Collection',
      displayName: 'Jane Doe',
    });
    expect(state).not.toHaveProperty('pat');
  });

  it('strips a trailing slash from the org URL before sending it and storing it -- prevents a broken // in work-item links built as `${orgUrl}/_workitems/edit/{id}`', async () => {
    vi.spyOn(httpClient, 'post').mockResolvedValueOnce({ data: { displayName: 'Jane Doe' } });

    renderLogin();
    fireEvent.change(screen.getByLabelText('ADO Organization URL'), { target: { value: 'https://dev.azure.com/elisradevops/' } });
    fireEvent.change(screen.getByLabelText('Personal Access Token'), { target: { value: 'fake-pat' } });
    fireEvent.click(screen.getByText('Sign in'));

    await waitFor(() => expect(screen.getByText('Jobs Page')).toBeInTheDocument());
    expect(httpClient.post).toHaveBeenCalledWith('/auth/login', {
      adoOrgUrl: 'https://dev.azure.com/elisradevops',
      pat: 'fake-pat',
    });
    expect(useAuthStore.getState().orgUrl).toBe('https://dev.azure.com/elisradevops');
  });

  it('handleLogin: ignores a rapid resubmission (double-click / Enter) while the first request is still in flight (isLoggingInRef guard -- both fireEvent.click calls batched inside one act() so no re-render, and thus no disabled attribute, lands between them; this is what reproduces the "second click before the first re-render" race the ref guard fixes, same technique as Settings.test.tsx\'s isReconnectingRef test)', async () => {
    let resolvePost: (value: { data: { displayName: string } }) => void;
    const postPromise = new Promise<{ data: { displayName: string } }>((resolve) => {
      resolvePost = resolve;
    });
    vi.spyOn(httpClient, 'post').mockReturnValueOnce(postPromise);

    renderLogin();
    fireEvent.change(screen.getByLabelText('ADO Organization URL'), { target: { value: 'https://tfs.internal/tfs/Collection' } });
    fireEvent.change(screen.getByLabelText('Personal Access Token'), { target: { value: 'fake-pat' } });
    const submitButton = screen.getByText('Sign in');
    act(() => {
      fireEvent.click(submitButton);
      fireEvent.click(submitButton);
    });

    expect(httpClient.post).toHaveBeenCalledTimes(1);
    resolvePost!({ data: { displayName: 'Jane Doe' } });
    await waitFor(() => expect(screen.getByText('Jobs Page')).toBeInTheDocument());
  });

  it('shows an error alert when sign-in fails', async () => {
    vi.spyOn(httpClient, 'post').mockRejectedValueOnce(new Error('Invalid ADO organization URL or Personal Access Token'));

    renderLogin();
    fireEvent.change(screen.getByLabelText('ADO Organization URL'), { target: { value: 'https://tfs.internal/tfs/Collection' } });
    fireEvent.change(screen.getByLabelText('Personal Access Token'), { target: { value: 'fake-pat' } });
    fireEvent.click(screen.getByText('Sign in'));

    await waitFor(() => expect(screen.getByText('Invalid ADO organization URL or Personal Access Token')).toBeInTheDocument());
  });
});
