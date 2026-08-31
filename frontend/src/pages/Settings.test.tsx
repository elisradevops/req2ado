import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Settings } from './Settings';
import { ToastProvider } from '../components/ToastProvider';
import { useAuthStore } from '../store/authStore';
import { httpClient } from '../api/httpClient';
import * as kbApi from '../api/kb';
import * as settingsApi from '../api/settings';
import * as llmConnectionApi from '../api/llmConnection';

vi.mock('../api/httpClient', () => ({ httpClient: { post: vi.fn() } }));
vi.mock('../api/kb');
vi.mock('../api/settings');
vi.mock('../api/llmConnection');

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
    vi.spyOn(llmConnectionApi, 'getLlmConnection').mockResolvedValue({ configured: false });
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

  // isReconnectingRef guard -- fireEvent.click (not userEvent.click) is used
  // here because userEvent.click would await a re-render between the two
  // clicks, which would already show the button disabled and prove nothing
  // about the synchronous guard itself. Same technique as
  // ChatPanel.test.tsx's isStreamingRef test.
  it('does not fire a second /auth/ado-credential call while the first reconnect is still in flight', async () => {
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
    await waitFor(() => expect(screen.getByText(/azure devops connection updated/i)).toBeInTheDocument());
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

    // isSharePointReconnectingRef guard -- fireEvent.click, same technique
    // as ChatPanel.test.tsx's isStreamingRef test (see the
    // isReconnectingRef test above for why fireEvent.click is required here).
    it('does not fire a second reconnectSharePoint call while the first reconnect is still in flight', async () => {
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

  describe('Open WebUI integration row + dialog', () => {
    it('shows "Not configured" when the caller has no vaulted connection', async () => {
      renderPage();
      await waitFor(() => expect(screen.getByText('Open WebUI')).toBeInTheDocument());
      expect(screen.getByText('Not configured')).toBeInTheDocument();
    });

    it('shows the connected chat model once a connection is configured', async () => {
      vi.spyOn(llmConnectionApi, 'getLlmConnection').mockResolvedValue({ configured: true, chatModel: 'qwen2.5:14b' });
      renderPage();
      await waitFor(() => expect(screen.getByText(/connected · qwen2.5:14b/i)).toBeInTheDocument());
    });

    it('loads the model catalog for a pasted token and saves the selected chat/vision models', async () => {
      vi.spyOn(llmConnectionApi, 'getLlmConnectionModels').mockResolvedValue([
        { id: 'qwen2.5:14b', name: 'qwen2.5:14b', vision: false },
        { id: 'gemma4:e4b', name: 'gemma4:e4b', vision: true },
      ]);
      vi.spyOn(llmConnectionApi, 'setLlmConnection').mockResolvedValue(undefined);
      renderPage();

      await waitFor(() => expect(screen.getByText('Open WebUI')).toBeInTheDocument());
      const configureButtons = screen.getAllByRole('button', { name: /^configure$/i });
      await userEvent.click(configureButtons[configureButtons.length - 1]);
      await userEvent.type(screen.getByLabelText(/open webui api token/i), 'sk-test-token');
      await userEvent.click(screen.getByRole('button', { name: /load models/i }));

      await waitFor(() => expect(llmConnectionApi.getLlmConnectionModels).toHaveBeenCalledWith('sk-test-token'));
      // Select is a Radix combobox+listbox, not a native <select> -- see
      // ProjectPicker.test.tsx's own comment for why this is open-then-
      // click-option rather than userEvent.selectOptions.
      await userEvent.click(screen.getByLabelText(/chat model/i));
      await userEvent.click(await screen.findByRole('option', { name: 'qwen2.5:14b' }));
      await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

      await waitFor(() =>
        expect(llmConnectionApi.setLlmConnection).toHaveBeenCalledWith('sk-test-token', 'qwen2.5:14b', undefined),
      );
      await waitFor(() => expect(screen.getByText(/open webui connection saved/i)).toBeInTheDocument());
    });

    it('shows an inline error and does not save when the pasted token fails validation', async () => {
      vi.spyOn(llmConnectionApi, 'getLlmConnectionModels').mockRejectedValue(new Error('401'));
      renderPage();

      await waitFor(() => expect(screen.getByText('Open WebUI')).toBeInTheDocument());
      const configureButtons = screen.getAllByRole('button', { name: /^configure$/i });
      await userEvent.click(configureButtons[configureButtons.length - 1]);
      await userEvent.type(screen.getByLabelText(/open webui api token/i), 'bad-token');
      await userEvent.click(screen.getByRole('button', { name: /load models/i }));

      await waitFor(() => expect(screen.getByText(/could not validate this token/i)).toBeInTheDocument());
      expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled();
    });
  });
});
