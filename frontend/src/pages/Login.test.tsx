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
    fireEvent.change(screen.getByLabelText('Azure DevOps organization URL'), { target: { value: 'https://tfs.internal/tfs/Collection' } });
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
    fireEvent.change(screen.getByLabelText('Azure DevOps organization URL'), { target: { value: 'https://tfs.internal/tfs/Collection' } });
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
    fireEvent.change(screen.getByLabelText('Azure DevOps organization URL'), { target: { value: 'https://dev.azure.com/elisradevops/' } });
    fireEvent.change(screen.getByLabelText('Personal Access Token'), { target: { value: 'fake-pat' } });
    fireEvent.click(screen.getByText('Sign in'));

    await waitFor(() => expect(screen.getByText('Jobs Page')).toBeInTheDocument());
    expect(httpClient.post).toHaveBeenCalledWith('/auth/login', {
      adoOrgUrl: 'https://dev.azure.com/elisradevops',
      pat: 'fake-pat',
    });
    expect(useAuthStore.getState().orgUrl).toBe('https://dev.azure.com/elisradevops');
  });

  // isLoggingInRef guard -- both fireEvent.click calls are batched inside
  // one act() so no re-render (and thus no disabled attribute) lands
  // between them; this is what reproduces the "second click before the
  // first re-render" race the ref guard fixes. Same technique as
  // Settings.test.tsx's isReconnectingRef test.
  it('handleLogin: ignores a rapid resubmission (double-click / Enter) while the first request is still in flight', async () => {
    let resolvePost: (value: { data: { displayName: string } }) => void;
    const postPromise = new Promise<{ data: { displayName: string } }>((resolve) => {
      resolvePost = resolve;
    });
    vi.spyOn(httpClient, 'post').mockReturnValueOnce(postPromise);

    renderLogin();
    fireEvent.change(screen.getByLabelText('Azure DevOps organization URL'), { target: { value: 'https://tfs.internal/tfs/Collection' } });
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
    fireEvent.change(screen.getByLabelText('Azure DevOps organization URL'), { target: { value: 'https://tfs.internal/tfs/Collection' } });
    fireEvent.change(screen.getByLabelText('Personal Access Token'), { target: { value: 'fake-pat' } });
    fireEvent.click(screen.getByText('Sign in'));

    await waitFor(() => expect(screen.getByText('Invalid ADO organization URL or Personal Access Token')).toBeInTheDocument());
  });

  describe('layout', () => {
    it('welcomes the user, and says in a line what signing in does', () => {
      renderLogin();

      expect(screen.getByRole('heading', { level: 1, name: 'Welcome to req2ado' })).toBeInTheDocument();
      expect(screen.getByText(/personal access token identifies you/i)).toBeInTheDocument();
    });

    it('puts the token help in the label row, beside the label, not beside the input', () => {
      renderLogin();

      const input = screen.getByLabelText('Personal Access Token');
      const label = document.querySelector(`label[for="${input.id}"]`) as HTMLElement;
      const tip = screen.getByRole('button', { name: /more information/i });
      // the tip lives in the same row as the label, so it can never narrow the field or sit off its baseline
      expect(label.parentElement).toContainElement(tip);
      expect(label.parentElement).not.toContainElement(input);
    });

    it('gives both fields the full width of the form', () => {
      renderLogin();

      expect(screen.getByLabelText('Azure DevOps organization URL').className).toContain('w-full');
      expect(screen.getByLabelText('Personal Access Token').className).toContain('w-full');
    });

    it('shows an example of the organization address', () => {
      renderLogin();

      expect(screen.getByLabelText('Azure DevOps organization URL')).toHaveAttribute('placeholder', expect.stringMatching(/^https:\/\//));
    });

    it('has a brand panel with the product name that is not part of the form', () => {
      renderLogin();

      const brand = screen.getByTestId('login-brand');
      expect(brand).toHaveTextContent('req2ado');
      expect(brand.querySelector('button, input, a')).toBeNull();
    });
  });

  it('keeps the e-mail and account name the server returns, for the Profile page', async () => {
    vi.spyOn(httpClient, 'post').mockResolvedValueOnce({ data: { displayName: 'Jane Doe', userId: 'u1', email: 'jane@corp.example', accountName: 'CORP\\jane' } });
    renderLogin();
    fireEvent.change(screen.getByLabelText('Azure DevOps organization URL'), { target: { value: 'https://tfs.internal/tfs/Collection' } });
    fireEvent.change(screen.getByLabelText('Personal Access Token'), { target: { value: 'fake-pat' } });
    fireEvent.click(screen.getByText('Sign in'));

    await waitFor(() => expect(useAuthStore.getState().email).toBe('jane@corp.example'));
    expect(useAuthStore.getState().accountName).toBe('CORP\\jane');
  });
});
