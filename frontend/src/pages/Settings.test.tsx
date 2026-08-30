import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Settings } from './Settings';
import { ToastProvider } from '../components/ToastProvider';
import { useAuthStore } from '../store/authStore';
import { httpClient } from '../api/httpClient';
import * as kbApi from '../api/kb';
import * as settingsApi from '../api/settings';

vi.mock('../api/httpClient', () => ({ httpClient: { post: vi.fn() } }));
vi.mock('../api/kb');
vi.mock('../api/settings');

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
    vi.spyOn(settingsApi, 'getAppSettings').mockResolvedValue({ dedupThreshold: 0.9 });
    vi.spyOn(settingsApi, 'updateAppSettings').mockResolvedValue({ dedupThreshold: 0.9 });
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

  it('does not fire a second /auth/ado-credential call while the first reconnect is still in flight (isReconnectingRef guard -- fireEvent.click, same technique as ChatPanel.test.tsx\'s isStreamingRef test, since userEvent.click would await a re-render between clicks and prove nothing about the synchronous guard)', async () => {
    let resolvePost: () => void = () => {};
    vi.mocked(httpClient.post).mockImplementation(() => new Promise((resolve) => { resolvePost = () => resolve({ data: { ok: true } }); }));
    renderPage();

    await userEvent.click(screen.getByRole('button', { name: /reconnect/i }));
    await userEvent.type(screen.getByLabelText(/personal access token/i), 'new-pat-value');
    const reconnectButtons = screen.getAllByRole('button', { name: /^reconnect$/i });
    const submitButton = reconnectButtons[reconnectButtons.length - 1];
    // Both clicks are batched inside one act() so no re-render (and thus no
    // disabled attribute) lands between them -- this is what reproduces the
    // "second click before the first re-render" race the ref guard fixes;
    // two sequential un-batched fireEvent.click calls would already see the
    // button disabled by React's synchronous discrete-event flush and prove
    // nothing about the guard itself.
    act(() => {
      fireEvent.click(submitButton);
      fireEvent.click(submitButton);
    });

    expect(httpClient.post).toHaveBeenCalledTimes(1);
    resolvePost();
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

    it('does not fire a second reconnectSharePoint call while the first reconnect is still in flight (isSharePointReconnectingRef guard -- fireEvent.click, same technique as ChatPanel.test.tsx\'s isStreamingRef test)', async () => {
      vi.mocked(kbApi.getSharePointStatus).mockResolvedValue({ status: 'invalid', expiresInSeconds: null });
      let resolveReconnect: () => void = () => {};
      vi.spyOn(kbApi, 'reconnectSharePoint').mockImplementation(
        () => new Promise((resolve) => { resolveReconnect = () => resolve({ status: 'valid', expiresInSeconds: 3600 }); }),
      );
      renderPage();

      await waitFor(() => expect(screen.getByRole('button', { name: /^reconnect$/i })).toBeInTheDocument());
      const reconnectButtons = screen.getAllByRole('button', { name: /^reconnect$/i });
      await userEvent.click(reconnectButtons[reconnectButtons.length - 1]);
      await userEvent.type(screen.getByLabelText(/sharepoint access token/i), 'new-token');
      const submitButton = screen.getAllByRole('button', { name: /^reconnect$/i }).at(-1)!;
      // Both clicks batched in one act() -- see the isReconnectingRef test
      // above for why un-batched sequential fireEvent.click calls wouldn't
      // reproduce the race (React's synchronous discrete-event flush would
      // already disable the button between them).
      act(() => {
        fireEvent.click(submitButton);
        fireEvent.click(submitButton);
      });

      expect(kbApi.reconnectSharePoint).toHaveBeenCalledTimes(1);
      resolveReconnect();
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

  describe('Duplicate Detection threshold (NEW-07)', () => {
    async function findThresholdField(): Promise<HTMLInputElement> {
      return (await screen.findByLabelText(/similarity threshold percentage/i)) as HTMLInputElement;
    }

    it('renders the section with the fetched threshold as a percentage', async () => {
      vi.mocked(settingsApi.getAppSettings).mockResolvedValue({ dedupThreshold: 0.85 });
      renderPage();

      expect(await screen.findByText('Duplicate Detection')).toBeInTheDocument();
      expect(await findThresholdField()).toHaveValue(85);
    });

    it('saves the edited percentage back as a 0-1 fraction', async () => {
      vi.mocked(settingsApi.updateAppSettings).mockResolvedValue({ dedupThreshold: 0.94 });
      renderPage();

      const field = await findThresholdField();
      await userEvent.clear(field);
      await userEvent.type(field, '94');
      await userEvent.click(screen.getByRole('button', { name: /save threshold/i }));

      await waitFor(() => expect(settingsApi.updateAppSettings).toHaveBeenCalledWith(0.94));
      await waitFor(() => expect(screen.getByText(/duplicate detection threshold saved/i)).toBeInTheDocument());
    });

    it('keeps Save disabled until the value actually changes', async () => {
      renderPage();

      await findThresholdField();
      expect(screen.getByRole('button', { name: /save threshold/i })).toBeDisabled();
    });

    it('shows an inline error and does not crash when the save fails', async () => {
      vi.mocked(settingsApi.updateAppSettings).mockRejectedValue(new Error('500'));
      renderPage();

      const field = await findThresholdField();
      await userEvent.clear(field);
      await userEvent.type(field, '80');
      await userEvent.click(screen.getByRole('button', { name: /save threshold/i }));

      await waitFor(() => expect(screen.getByText(/couldn't save the threshold/i)).toBeInTheDocument());
      // Still editable, and the draft is preserved so the retry is one click.
      expect(await findThresholdField()).toHaveValue(80);
    });

    it('surfaces a load failure instead of leaving the control blank and silent', async () => {
      vi.mocked(settingsApi.getAppSettings).mockRejectedValue(new Error('500'));
      renderPage();

      await waitFor(() => expect(screen.getByText(/couldn't load the current threshold/i)).toBeInTheDocument());
      expect(await findThresholdField()).toBeDisabled();
    });
  });
});
