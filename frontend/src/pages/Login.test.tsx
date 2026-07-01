import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Login } from './Login';
import { httpClient } from '../api/httpClient';

describe('Login page', () => {
  afterEach(() => vi.restoreAllMocks());

  it('disables the validate button until both fields are filled', () => {
    render(<Login />);
    expect(screen.getByText('Validate connection')).toBeDisabled();
  });

  it('shows a success alert when validation succeeds', async () => {
    vi.spyOn(httpClient, 'post').mockResolvedValueOnce({ data: { ok: true } });

    render(<Login />);
    fireEvent.change(screen.getByLabelText('ADO Organization URL'), { target: { value: 'https://tfs.internal/tfs/Collection' } });
    fireEvent.change(screen.getByLabelText('Personal Access Token'), { target: { value: 'fake-pat' } });
    fireEvent.click(screen.getByText('Validate connection'));

    await waitFor(() => expect(screen.getByText('Connection validated.')).toBeInTheDocument());
    expect(httpClient.post).toHaveBeenCalledWith(
      '/connection/validate',
      {},
      { headers: { 'X-Ado-Org-Url': 'https://tfs.internal/tfs/Collection', 'X-Ado-Pat': 'fake-pat' } },
    );
  });

  it('shows an error alert when validation fails', async () => {
    vi.spyOn(httpClient, 'post').mockRejectedValueOnce(new Error('bad credentials'));

    render(<Login />);
    fireEvent.change(screen.getByLabelText('ADO Organization URL'), { target: { value: 'https://tfs.internal/tfs/Collection' } });
    fireEvent.change(screen.getByLabelText('Personal Access Token'), { target: { value: 'fake-pat' } });
    fireEvent.click(screen.getByText('Validate connection'));

    await waitFor(() => expect(screen.getByText('bad credentials')).toBeInTheDocument());
  });
});
