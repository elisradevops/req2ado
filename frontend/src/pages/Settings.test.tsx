import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Settings } from './Settings';
import { ToastProvider } from '../components/ToastProvider';
import { useAuthStore } from '../store/authStore';
import { httpClient } from '../api/httpClient';
import * as kbApi from '../api/kb';

vi.mock('../api/httpClient', () => ({ httpClient: { post: vi.fn() } }));
vi.mock('../api/kb');

function renderPage(): void {
  useAuthStore.getState().login('https://ado.example', 'Jane Doe', 'user-descriptor-1');
  render(
    <ToastProvider>
      <Settings />
    </ToastProvider>,
  );
}

describe('Settings', () => {
  beforeEach(() => {
    vi.mocked(httpClient.post).mockReset();
    vi.spyOn(kbApi, 'getSharePointStatus').mockResolvedValue({ status: 'valid', expiresInSeconds: 2820 });
  });

  it('shows the signed-in identity and current org URL', () => {
    renderPage();
    expect(screen.getByText('Jane Doe')).toBeInTheDocument();
    expect(screen.getByText('https://ado.example')).toBeInTheDocument();
  });

  it('reconnect calls /auth/ado-credential (not /auth/login -- no new session) and updates the stored org URL', async () => {
    vi.mocked(httpClient.post).mockResolvedValue({ data: { ok: true } });
    renderPage();

    await userEvent.click(screen.getByRole('button', { name: /reconnect/i }));
    const dialogPatField = screen.getByLabelText(/personal access token/i);
    await userEvent.type(dialogPatField, 'new-pat-value');
    await userEvent.click(screen.getByRole('button', { name: /^reconnect$/i, hidden: false }));

    await waitFor(() =>
      expect(httpClient.post).toHaveBeenCalledWith('/auth/ado-credential', { adoOrgUrl: 'https://ado.example', pat: 'new-pat-value' }),
    );
    expect(useAuthStore.getState()).not.toHaveProperty('pat');
    expect(useAuthStore.getState().orgUrl).toBe('https://ado.example');
  });

  it('shows an error and keeps the dialog open when reconnect fails', async () => {
    vi.mocked(httpClient.post).mockRejectedValue(new Error('401'));
    renderPage();

    await userEvent.click(screen.getByRole('button', { name: /reconnect/i }));
    await userEvent.type(screen.getByLabelText(/personal access token/i), 'bad-pat');
    const reconnectButtons = screen.getAllByRole('button', { name: /^reconnect$/i });
    await userEvent.click(reconnectButtons[reconnectButtons.length - 1]);

    await waitFor(() => expect(screen.getByText(/invalid ado organization url or personal access token/i)).toBeInTheDocument());
  });

  describe('SharePoint integration row + Display Preferences (DESIGN.md Track B, phase B11)', () => {
    it('shows the real SharePoint connection status once it resolves', async () => {
      vi.mocked(kbApi.getSharePointStatus).mockResolvedValue({ status: 'invalid', expiresInSeconds: null });
      renderPage();

      await waitFor(() => expect(screen.getByText(/token invalid/i)).toBeInTheDocument());
      expect(screen.getByText(/reauthentication required/i)).toBeInTheDocument();
    });

    it('reconnects SharePoint via the same reconnectSharePoint call KnowledgeBase.tsx uses', async () => {
      vi.mocked(kbApi.getSharePointStatus).mockResolvedValue({ status: 'invalid', expiresInSeconds: null });
      vi.spyOn(kbApi, 'reconnectSharePoint').mockResolvedValue({ status: 'valid', expiresInSeconds: 3600 });
      renderPage();

      await waitFor(() => expect(screen.getByRole('button', { name: /^reconnect$/i })).toBeInTheDocument());
      const reconnectButtons = screen.getAllByRole('button', { name: /^reconnect$/i });
      await userEvent.click(reconnectButtons[reconnectButtons.length - 1]);
      await userEvent.type(screen.getByLabelText(/sharepoint access token/i), 'new-token');
      await userEvent.click(screen.getAllByRole('button', { name: /^reconnect$/i }).at(-1)!);

      await waitFor(() => expect(kbApi.reconnectSharePoint).toHaveBeenCalledWith('new-token'));
      await waitFor(() => expect(screen.getByText(/sharepoint reconnected/i)).toBeInTheDocument());
    });

    it('toggles Dense View and persists it to localStorage', async () => {
      renderPage();
      const toggle = screen.getByRole('switch', { name: /dense view/i });
      expect(toggle).toHaveAttribute('aria-checked', 'false');

      await userEvent.click(toggle);

      expect(toggle).toHaveAttribute('aria-checked', 'true');
      expect(JSON.parse(localStorage.getItem('req2ado-ui-preferences')!)).toMatchObject({ denseView: true });
    });

    it('toggles Auto-Sync Ledgers, defaulting to on', async () => {
      renderPage();
      const toggle = screen.getByRole('switch', { name: /auto-sync ledgers/i });
      expect(toggle).toHaveAttribute('aria-checked', 'true');

      await userEvent.click(toggle);

      expect(toggle).toHaveAttribute('aria-checked', 'false');
    });
  });
});
