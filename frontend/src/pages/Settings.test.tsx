import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Settings } from './Settings';
import { ToastProvider } from '../components/ToastProvider';
import { useAuthStore } from '../store/authStore';
import { httpClient } from '../api/httpClient';
import * as kbApi from '../api/kb';
import * as settingsApi from '../api/settings';
import * as llmConnectionApi from '../api/llmConnection';
import { useConnectionStatusStore } from '../store/connectionStatusStore';

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

  it('names every review shortcut in the Keyboard shortcuts description (the guide lists the same seven)', () => {
    renderPage();
    expect(screen.getByText('Single-key shortcuts while reviewing: J, K, A, R, X, E and U')).toBeInTheDocument();
  });

  it('shows the signed-in identity and current org URL', () => {
    renderPage();
    expect(screen.getByText('Jane Doe')).toBeInTheDocument();
    expect(screen.getByText(/https:\/\/ado\.example/)).toBeInTheDocument();
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

    await waitFor(() => expect(screen.getByText(/invalid azure devops organization url or personal access token/i)).toBeInTheDocument());
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

  describe('SharePoint integration row + Display preferences (DESIGN.md Track B, phase B11)', () => {
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

    it('toggles Dense view and persists it to localStorage', async () => {
      renderPage();
      const toggle = screen.getByRole('switch', { name: /dense view/i });
      expect(toggle).toHaveAttribute('aria-checked', 'false');

      await userEvent.click(toggle);

      expect(toggle).toHaveAttribute('aria-checked', 'true');
      expect(JSON.parse(localStorage.getItem('req2ado-ui-preferences')!)).toMatchObject({ denseView: true });
    });

    it('toggles Keyboard shortcuts, defaulting to on, and keeps the other saved preferences', async () => {
      renderPage();
      const toggle = screen.getByRole('switch', { name: /keyboard shortcuts/i });
      expect(toggle).toHaveAttribute('aria-checked', 'true');

      await userEvent.click(toggle);

      expect(toggle).toHaveAttribute('aria-checked', 'false');
      expect(JSON.parse(localStorage.getItem('req2ado-ui-preferences')!)).toMatchObject({ keyboardShortcuts: false });
      // Saving another preference afterwards must not drop this one.
      const dense = screen.getByRole('switch', { name: /dense view/i });
      const denseBefore = dense.getAttribute('aria-checked') === 'true';
      await userEvent.click(dense);
      expect(JSON.parse(localStorage.getItem('req2ado-ui-preferences')!)).toMatchObject({
        keyboardShortcuts: false,
        denseView: !denseBefore,
      });
    });

    it('toggles the Jobs list refresh, defaulting to on', async () => {
      renderPage();
      const toggle = screen.getByRole('switch', { name: /refresh the jobs list/i });
      expect(toggle).toHaveAttribute('aria-checked', 'true');

      await userEvent.click(toggle);

      expect(toggle).toHaveAttribute('aria-checked', 'false');
    });
  });

  describe('Duplicate detection threshold (NEW-07)', () => {
    async function findThresholdField(): Promise<HTMLInputElement> {
      return (await screen.findByLabelText(/similarity threshold percentage/i)) as HTMLInputElement;
    }

    it('renders the section with the fetched threshold as a percentage', async () => {
      vi.mocked(settingsApi.getAppSettings).mockResolvedValue({ dedupThreshold: 0.85 });
      renderPage();

      expect(await screen.findByText('Duplicate detection')).toBeInTheDocument();
      expect(await findThresholdField()).toHaveValue(85);
    });

    it('says in plain words what the threshold does, and that nothing is skipped without a confirmation', async () => {
      vi.mocked(settingsApi.getAppSettings).mockResolvedValue({ dedupThreshold: 0.9 });
      renderPage();

      await findThresholdField();

      expect(screen.getByText(/how alike two items must be to count as duplicates/i)).toBeInTheDocument();
      expect(screen.getByText(/a second check confirms every match; if it cannot run, nothing is skipped/i)).toBeInTheDocument();
    });

    it('shows the embedding model the similarity is measured with, as read-only information', async () => {
      vi.mocked(settingsApi.getAppSettings).mockResolvedValue({ dedupThreshold: 0.9, embeddingModel: 'text-embedding-3-small' });
      renderPage();

      await findThresholdField();

      expect(screen.getByText('text-embedding-3-small')).toBeInTheDocument();
      expect(screen.getByText(/set by whoever runs this system/i)).toBeInTheDocument();
      expect(screen.queryByRole('textbox', { name: /embedding model/i })).toBeNull();
    });

    it('says nothing about a model when the server did not name one', async () => {
      vi.mocked(settingsApi.getAppSettings).mockResolvedValue({ dedupThreshold: 0.9 });
      renderPage();

      await findThresholdField();

      expect(screen.queryByText(/set by whoever runs this system/i)).toBeNull();
    });

    describe('who may change it', () => {
      it('is read-only, with the reason, for a user who may not edit it', async () => {
        vi.mocked(settingsApi.getAppSettings).mockResolvedValue({ dedupThreshold: 0.9, canEditDedupThreshold: false });
        renderPage();

        const field = await findThresholdField();

        expect(field).toBeDisabled();
        expect(screen.getByRole('button', { name: /save threshold/i })).toBeDisabled();
        expect(screen.getByText(/only an administrator can change this/i)).toBeInTheDocument();
      });

      it('is editable, with no note, when the server says the user may', async () => {
        vi.mocked(settingsApi.getAppSettings).mockResolvedValue({ dedupThreshold: 0.9, canEditDedupThreshold: true });
        renderPage();

        expect(await findThresholdField()).toBeEnabled();
        expect(screen.queryByText(/only an administrator can change this/i)).toBeNull();
      });

      it('is editable against a server that does not say (an older one)', async () => {
        vi.mocked(settingsApi.getAppSettings).mockResolvedValue({ dedupThreshold: 0.9 });
        renderPage();

        expect(await findThresholdField()).toBeEnabled();
      });

      it('says so, in words, when a save is refused as not allowed', async () => {
        const refused = Object.assign(new Error('403'), { isAxiosError: true, response: { status: 403, data: { code: 'settings_forbidden' } } });
        vi.mocked(settingsApi.updateAppSettings).mockRejectedValue(refused);
        renderPage();

        const field = await findThresholdField();
        await userEvent.clear(field);
        await userEvent.type(field, '80');
        await userEvent.click(screen.getByRole('button', { name: /save threshold/i }));

        expect(await screen.findByText(/only an administrator can change the threshold/i)).toBeInTheDocument();
        expect(screen.queryByText(/check your connection/i)).toBeNull();
      });
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

    it('loads the model catalog for a pasted token and saves the selected model (vision-capable only shown in picker)', async () => {
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
      // Single picker shows only vision-capable models -- gemma4:e4b (vision: true)
      // is the only option; qwen2.5:14b (vision: false) is filtered out.
      // Select is a Radix combobox+listbox, not a native <select> -- see
      // ProjectPicker.test.tsx's own comment for why this is open-then-
      // click-option rather than userEvent.selectOptions.
      await userEvent.click(screen.getByLabelText(/^model$/i));
      await userEvent.click(await screen.findByRole('option', { name: 'gemma4:e4b' }));
      await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

      // No visionModel arg -- the single picker collapsed chat+vision into one field.
      await waitFor(() =>
        expect(llmConnectionApi.setLlmConnection).toHaveBeenCalledWith('sk-test-token', 'gemma4:e4b'),
      );
      await waitFor(() => expect(screen.getByText(/open webui connection saved/i)).toBeInTheDocument());
    });

    it('saves the connection and says duplicate detection cannot use it when the account cannot embed', async () => {
      vi.spyOn(llmConnectionApi, 'getLlmConnectionModels').mockResolvedValue([{ id: 'gemma4:e4b', name: 'gemma4:e4b', vision: true }]);
      vi.spyOn(llmConnectionApi, 'setLlmConnection').mockResolvedValue({ embeddings: 'unavailable' });
      renderPage();

      await waitFor(() => expect(screen.getByText('Open WebUI')).toBeInTheDocument());
      const configureButtons = screen.getAllByRole('button', { name: /^configure$/i });
      await userEvent.click(configureButtons[configureButtons.length - 1]);
      await userEvent.type(screen.getByLabelText(/open webui api token/i), 'sk-test-token');
      await userEvent.click(screen.getByRole('button', { name: /load models/i }));
      await waitFor(() => expect(llmConnectionApi.getLlmConnectionModels).toHaveBeenCalled());
      await userEvent.click(screen.getByLabelText(/^model$/i));
      await userEvent.click(await screen.findByRole('option', { name: 'gemma4:e4b' }));
      await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

      await waitFor(() => expect(screen.getByText(/open webui connection saved/i)).toBeInTheDocument());
      expect(screen.getByText(/duplicate detection cannot use this connection yet/i)).toBeInTheDocument();
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

    it('keeps a pasted token in memory across a dialog close/reopen -- not cleared, so re-loading models does not require re-typing it', async () => {
      renderPage();

      await waitFor(() => expect(screen.getByText('Open WebUI')).toBeInTheDocument());
      const openDialog = () => {
        const configureButtons = screen.getAllByRole('button', { name: /^configure$/i });
        return userEvent.click(configureButtons[configureButtons.length - 1]);
      };

      await openDialog();
      await userEvent.type(screen.getByLabelText(/open webui api token/i), 'sk-in-progress-token');
      await userEvent.click(screen.getByRole('button', { name: /^cancel$/i }));

      await openDialog();

      expect(screen.getByLabelText(/open webui api token/i)).toHaveValue('sk-in-progress-token');
    });

    it('shows only vision-capable models in the picker and filters out non-vision models', async () => {
      vi.spyOn(llmConnectionApi, 'getLlmConnectionModels').mockResolvedValue([
        { id: 'qwen2.5:14b', name: 'qwen2.5:14b', vision: false },
        { id: 'devstral-small-2:24b', name: 'devstral-small-2:24b', vision: true },
      ]);
      renderPage();

      await waitFor(() => expect(screen.getByText('Open WebUI')).toBeInTheDocument());
      const configureButtons = screen.getAllByRole('button', { name: /^configure$/i });
      await userEvent.click(configureButtons[configureButtons.length - 1]);
      await userEvent.type(screen.getByLabelText(/open webui api token/i), 'sk-test-token');
      await userEvent.click(screen.getByRole('button', { name: /load models/i }));
      await waitFor(() => expect(llmConnectionApi.getLlmConnectionModels).toHaveBeenCalled());
      await userEvent.click(screen.getByLabelText(/^model$/i));
      // Popup options render only after llmModels' state update from the
      // mocked getLlmConnectionModels() promise settles -- waited for
      // explicitly since it can land after the click itself resolves.
      await waitFor(() => expect(screen.queryAllByRole('option').length).toBeGreaterThan(0));

      // Picker shows only vision-capable models; non-vision models are filtered out.
      expect(screen.getByRole('option', { name: 'devstral-small-2:24b' })).toBeInTheDocument();
      expect(screen.queryByRole('option', { name: 'qwen2.5:14b' })).not.toBeInTheDocument();
    });
  });

  describe('profile', () => {
    function renderWithDetails(): void {
      useAuthStore.getState().login('https://tfs.corp.example/tfs/DefaultCollection', 'Jane Doe', 'user-descriptor-1', { email: 'jane@corp.example', accountName: 'CORP\\jane' });
      render(
        <ToastProvider>
          <Settings />
        </ToastProvider>,
      );
    }

    it('shows who is signed in as ADO knows them, not the technical id', () => {
      renderWithDetails();

      expect(screen.getByText('jane@corp.example')).toBeInTheDocument();
      expect(screen.getByText('CORP\\jane')).toBeInTheDocument();
      expect(screen.getByText('tfs.corp.example')).toBeInTheDocument();
      expect(screen.queryByText('user-descriptor-1')).toBeNull();
    });

    it('keeps the details when the Azure DevOps token is reconnected', async () => {
      vi.mocked(httpClient.post).mockResolvedValue({ data: { ok: true } });
      renderWithDetails();

      await userEvent.click(screen.getByRole('button', { name: /reconnect/i }));
      await userEvent.type(screen.getByLabelText(/personal access token/i), 'new-pat-value');
      await userEvent.click(screen.getByRole('button', { name: /^reconnect$/i, hidden: false }));

      await waitFor(() => expect(httpClient.post).toHaveBeenCalled());
      await waitFor(() => expect(useAuthStore.getState().email).toBe('jane@corp.example'));
    });
  });

  describe('the Azure DevOps row says what the check found, not always "ok"', () => {
    const row = () => screen.getByText('Azure DevOps').closest('div.rounded-md') as HTMLElement;

    it('is plain when the connection is fine', () => {
      useConnectionStatusStore.setState({ ado: { data: { status: 'valid' }, error: false, checkedAt: 1, inFlight: false } });
      renderPage();

      expect(row().className).not.toMatch(/warning|danger/);
    });

    it('says "Connected" in words when the connection is fine, not by colour alone', () => {
      useConnectionStatusStore.setState({ ado: { data: { status: 'valid' }, error: false, checkedAt: 1, inFlight: false } });
      renderPage();

      expect(within(row()).getByText(/^connected · https:\/\/ado\.example$/i)).toBeInTheDocument();
    });

    it('says in words, as a danger, that its token was rejected', () => {
      useConnectionStatusStore.setState({ ado: { data: { status: 'invalid' }, error: false, checkedAt: 1, inFlight: false } });
      renderPage();

      expect(within(row()).getByText(/token rejected/i)).toBeInTheDocument();
      expect(row().className).toMatch(/danger/);
    });

    it('turns to a warning, in words, when it cannot be reached', () => {
      useConnectionStatusStore.setState({ ado: { data: { status: 'unreachable' }, error: false, checkedAt: 1, inFlight: false } });
      renderPage();

      expect(within(row()).getByText(/can't reach azure devops/i)).toBeInTheDocument();
    });
  });
});
