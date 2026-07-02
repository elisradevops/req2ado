import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Login } from './Login';
import { httpClient } from '../api/httpClient';

describe('Login page', () => {
  afterEach(() => vi.restoreAllMocks());

  it('disables the sign-in button until both fields are filled', () => {
    render(<Login />);
    expect(screen.getByText('Sign in')).toBeDisabled();
  });

  it('does not render an Azure AD sign-in option', () => {
    render(<Login />);
    expect(screen.queryByText(/Azure AD/i)).not.toBeInTheDocument();
  });

  it('shows a success alert and calls /auth/login when sign-in succeeds', async () => {
    vi.spyOn(httpClient, 'post').mockResolvedValueOnce({ data: { token: 'fake-jwt' } });

    render(<Login />);
    fireEvent.change(screen.getByLabelText('ADO Organization URL'), { target: { value: 'https://tfs.internal/tfs/Collection' } });
    fireEvent.change(screen.getByLabelText('Personal Access Token'), { target: { value: 'fake-pat' } });
    fireEvent.click(screen.getByText('Sign in'));

    await waitFor(() => expect(screen.getByText('Signed in successfully.')).toBeInTheDocument());
    expect(httpClient.post).toHaveBeenCalledWith('/auth/login', {
      adoOrgUrl: 'https://tfs.internal/tfs/Collection',
      pat: 'fake-pat',
    });
  });

  it('shows an error alert when sign-in fails', async () => {
    vi.spyOn(httpClient, 'post').mockRejectedValueOnce(new Error('Invalid ADO organization URL or Personal Access Token'));

    render(<Login />);
    fireEvent.change(screen.getByLabelText('ADO Organization URL'), { target: { value: 'https://tfs.internal/tfs/Collection' } });
    fireEvent.change(screen.getByLabelText('Personal Access Token'), { target: { value: 'fake-pat' } });
    fireEvent.click(screen.getByText('Sign in'));

    await waitFor(() => expect(screen.getByText('Invalid ADO organization URL or Personal Access Token')).toBeInTheDocument());
  });
});
