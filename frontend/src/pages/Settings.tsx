import { SharePointTokenHelp, SHAREPOINT_TOKEN_DIALOG_DESCRIPTION } from '../components/SharePointTokenHelp';
import { useEffect, useRef, useState } from 'react';
import { httpClient } from '../api/httpClient';
import { reconnectSharePoint, type SharePointStatus } from '../api/kb';
import { isAxiosError } from 'axios';
import { getAppSettings, updateAppSettings } from '../api/settings';
import { getLlmConnection, getLlmConnectionModels, setLlmConnection, type LlmConnectionStatus, type LlmSelectableModel } from '../api/llmConnection';
import { useConnectionStatusStore } from '../store/connectionStatusStore';
import { useLlmConnectionStore } from '../store/llmConnectionStore';
import { useAccountName, useAuthStore, useDisplayName, useEmail, useOrgUrl, useUserId } from '../store/authStore';
import { useDenseView, useAutoSyncLedgers, useKeyboardShortcuts, useUiPreferencesStore } from '../store/uiPreferencesStore';
import { useToast } from '../components/ToastProvider';
import { formatSharePointExpiry } from '../utils/sharePointStatus';
import { adoConnectionRow, type HealthState } from '../utils/connectionHealth';
import { ProfileCard } from '../components/ProfileCard';
import { usePageTitle } from '../hooks/usePageTitle';
import { PageHeader } from '../ui/PageHeader';
import { SectionCard } from '../ui/SectionCard';
import { Button } from '../ui/Button';
import { TextField } from '../ui/TextField';
import { Dialog } from '../ui/Dialog';
import { Spinner } from '../ui/Spinner';
import { Chip } from '../ui/Chip';
import { InfoTip } from '../ui/Tooltip';
import { Switch } from '../ui/Switch';
import { Select } from '../ui/Select';
import { Skeleton } from '../ui/Skeleton';
import { cn } from '../lib/cn';
import { Briefcase } from 'lucide-react';

type IntegrationTone = 'ok' | 'danger' | 'warning' | 'dim';

// What the connection check found, as the row's tone: a rejected credential is danger, an unreachable service a warning.
const ADO_TONE: Record<HealthState, IntegrationTone> = { ok: 'ok', attention: 'warning', danger: 'danger', off: 'dim', checking: 'dim' };

const SHAREPOINT_UNREACHABLE: SharePointStatus = { status: 'unreachable', expiresInSeconds: null };

const SHAREPOINT_COPY: Record<SharePointStatus['status'], { label: string; tone: IntegrationTone; reason: string | null }> = {
  valid: { label: 'Connected', tone: 'ok', reason: null },
  invalid: { label: 'Token invalid', tone: 'danger', reason: 'Token expired. Reauthentication required.' },
  unreachable: { label: 'Unreachable', tone: 'warning', reason: "Can't reach Microsoft Graph right now." },
  not_configured: { label: 'Not configured', tone: 'dim', reason: 'No access token has been set for the knowledge base.' },
};

const TONE_CHIP_CLASSES: Record<IntegrationTone, string> = {
  ok: 'bg-ok-soft text-ok-ink border-ok-border',
  danger: 'bg-danger-soft text-danger-ink border-danger-border',
  warning: 'bg-warning-soft text-warning-ink border-warning-border',
  dim: 'bg-surface-alt text-ink-3 border-hairline-strong',
};

// Only a real failure (danger/warning) gets the tinted card treatment --
// "not_configured" is a neutral, expected state (nothing was ever set up),
// not an error, so it stays visually calm like the connected case.
const TONE_CARD_CLASSES: Record<IntegrationTone, string> = {
  ok: 'border-hairline',
  dim: 'border-hairline',
  danger: 'border-danger-border bg-danger-soft/40',
  warning: 'border-warning-border bg-warning-soft/40',
};

// The API carries dedupThreshold as a cosine similarity in [0, 1], but this
// product describes it to users as a percentage everywhere else ("treat
// matches above 90% as existing duplicates"), so the control edits percent
// and converts at the boundary only.
const THRESHOLD_PERCENT_MIN = 0;
const THRESHOLD_PERCENT_MAX = 100;
const THRESHOLD_LOAD_ERROR = "Couldn't load the current threshold. Reload the page to try again.";
const THRESHOLD_SAVE_ERROR = "Couldn't save the threshold. Check your connection and try again.";
const THRESHOLD_FORBIDDEN_ERROR = 'Only an administrator can change the threshold.';
const THRESHOLD_RANGE_ERROR = `Enter a percentage between ${THRESHOLD_PERCENT_MIN} and ${THRESHOLD_PERCENT_MAX}.`;

// 0.905 -> "90.5". Rounds to one decimal place of a percent, which is finer
// than anyone tunes this and keeps float noise (0.8999999999) off screen.
function fractionToPercentText(fraction: number): string {
  if (!Number.isFinite(fraction)) return '';
  return String(Math.round(fraction * 1000) / 10);
}

// "90.5" -> 0.905. Returns null for anything the backend's own
// z.number().finite().min(0).max(1) would reject, so the Save button can be
// disabled instead of round-tripping a guaranteed 400.
function percentTextToFraction(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < THRESHOLD_PERCENT_MIN || parsed > THRESHOLD_PERCENT_MAX) return null;
  return Math.round(parsed * 10) / 1000;
}

const TONE_ACTION_LABEL: Record<IntegrationTone, string> = {
  ok: 'Configure',
  dim: 'Configure',
  danger: 'Reconnect',
  warning: 'Reconnect',
};

// A single integration row -- Azure DevOps and SharePoint both render the
// same shape (status chip, optional inline failure reason, one action
// button), matching the reference Settings mockup instead of the ADO-only
// SectionCard the page previously had.
function IntegrationRow({
  icon,
  name,
  detail,
  tone,
  reason,
  // Overrides TONE_ACTION_LABEL's generic default -- Azure DevOps always
  // says "Reconnect" regardless of tone (rotating/re-validating a PAT is
  // always a reconnect action here, matching this row's own dialog title,
  // "Reconnect to Azure DevOps"), unlike SharePoint's Configure/Reconnect
  // split which genuinely depends on whether a token was ever set.
  actionLabel,
  onAction,
}: {
  icon: React.ReactNode;
  name: string;
  detail: string;
  tone: IntegrationTone;
  reason?: string | null;
  actionLabel?: string;
  onAction: () => void;
}): React.ReactElement {
  return (
    <div className={cn('flex items-center gap-3 rounded-md border p-3', TONE_CARD_CLASSES[tone])}>
      <span className="grid h-8 w-8 flex-none place-items-center rounded-md bg-surface-alt text-ink-3">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium text-ink-1">
          {name}
          {/* The status can be long (an address, an expiry): it wraps inside the row instead of pushing the action off a narrow screen. */}
          <Chip className={cn('max-w-full rounded-lg border text-xs font-normal whitespace-normal [overflow-wrap:anywhere]', TONE_CHIP_CLASSES[tone])}>{detail}</Chip>
        </p>
        {reason && <p className="mt-0.5 text-xs text-danger-ink">{reason}</p>}
      </div>
      <Button size="sm" variant={tone === 'ok' || tone === 'dim' ? 'outline' : 'primary'} onClick={onAction}>
        {actionLabel ?? TONE_ACTION_LABEL[tone]}
      </Button>
    </div>
  );
}

function DisplayPreferenceRow({
  label,
  description,
  checked,
  onCheckedChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}): React.ReactElement {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="text-sm font-medium text-ink-1">{label}</p>
        <p className="text-xs text-ink-3">{description}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onCheckedChange} ariaLabel={label} />
    </div>
  );
}

/**
 * Profile & Connections. The ADO PAT is vaulted server-side (encrypted,
 * keyed to this session's userId -- credential-vault.service.ts), never
 * held by the browser after login. This screen's "Reconnect" calls
 * POST /auth/ado-credential -- re-validates the PAT and re-vaults it
 * WITHOUT issuing a new session, so rotating a PAT or fixing a typo'd org
 * URL doesn't force a full sign-out/sign-in.
 *
 * SharePoint's own reconnect (a single access token shared by every user of
 * the knowledge base, not per-user OAuth) reuses the exact same
 * getSharePointStatus/reconnectSharePoint calls KnowledgeBase.tsx already
 * makes -- surfaced here too so connection health for BOTH integrations is
 * visible from one place, matching the reference Settings layout, rather
 * than only ever being discoverable by visiting the Knowledge Base page.
 */
export function Settings(): React.ReactElement {
  usePageTitle('Profile and connections');
  const displayName = useDisplayName();
  const orgUrl = useOrgUrl();
  const userId = useUserId();
  const email = useEmail();
  const accountName = useAccountName();
  const adoEntry = useConnectionStatusStore((s) => s.ado);
  const adoRow = adoConnectionRow(adoEntry);
  const { showToast } = useToast();
  const denseView = useDenseView();
  const autoSyncLedgers = useAutoSyncLedgers();
  const keyboardShortcuts = useKeyboardShortcuts();
  const [reconnectOpen, setReconnectOpen] = useState(false);
  const [newOrgUrl, setNewOrgUrl] = useState(orgUrl ?? '');
  const [newPat, setNewPat] = useState('');
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [reconnectError, setReconnectError] = useState<string | null>(null);

  // Shared with the rest of the app (polled and refreshed in one place); a check that failed reads as unreachable.
  const sharePointEntry = useConnectionStatusStore((s) => s.sharePoint);
  const sharePointStatus = sharePointEntry.error ? SHAREPOINT_UNREACHABLE : sharePointEntry.data;
  const [sharePointReconnectOpen, setSharePointReconnectOpen] = useState(false);
  const [sharePointToken, setSharePointToken] = useState('');
  const [isSharePointReconnecting, setIsSharePointReconnecting] = useState(false);
  const [sharePointReconnectError, setSharePointReconnectError] = useState<string | null>(null);

  const [llmConnection, setLlmConnectionState] = useState<LlmConnectionStatus | null>(null);
  const [llmDialogOpen, setLlmDialogOpen] = useState(false);
  const [llmToken, setLlmToken] = useState('');
  const [llmModels, setLlmModels] = useState<LlmSelectableModel[]>([]);
  const [llmChatModel, setLlmChatModel] = useState('');
  const [isLoadingLlmModels, setIsLoadingLlmModels] = useState(false);
  const [isSavingLlmConnection, setIsSavingLlmConnection] = useState(false);
  const [llmConnectionError, setLlmConnectionError] = useState<string | null>(null);
  const isLoadingLlmModelsRef = useRef(false);
  const isSavingLlmConnectionRef = useRef(false);

  // Draft (what's in the field) vs saved (what the server last confirmed) --
  // the pair is what makes the Save button honest about being dirty.
  const [thresholdPercent, setThresholdPercent] = useState('');
  const [savedThresholdPercent, setSavedThresholdPercent] = useState<string | null>(null);
  const [isThresholdLoading, setIsThresholdLoading] = useState(true);
  const [embeddingModel, setEmbeddingModel] = useState<string | null>(null);
  // Whether this user may change the threshold; true until the server says otherwise (an older one let everyone).
  const [canEditThreshold, setCanEditThreshold] = useState(true);
  const [isSavingThreshold, setIsSavingThreshold] = useState(false);
  const [thresholdError, setThresholdError] = useState<string | null>(null);
  const isSavingThresholdRef = useRef(false);
  const isReconnectingRef = useRef(false);
  const isSharePointReconnectingRef = useRef(false);

  useEffect(() => {
    void useConnectionStatusStore.getState().refresh('sharePoint');
  }, []);

  useEffect(() => {
    getLlmConnection()
      .then(setLlmConnectionState)
      .catch(() => setLlmConnectionState({ configured: false }));
  }, []);

  useEffect(() => {
    getAppSettings()
      .then((settings) => {
        const percentText = fractionToPercentText(settings.dedupThreshold);
        setThresholdPercent(percentText);
        setSavedThresholdPercent(percentText);
        setEmbeddingModel(settings.embeddingModel ?? null);
        setCanEditThreshold(settings.canEditDedupThreshold !== false);
      })
      .catch(() => setThresholdError(THRESHOLD_LOAD_ERROR))
      .finally(() => setIsThresholdLoading(false));
  }, []);

  function openReconnect(): void {
    setNewOrgUrl(orgUrl ?? '');
    setNewPat('');
    setReconnectError(null);
    setReconnectOpen(true);
  }

  async function handleReconnect(): Promise<void> {
    // Synchronous ref guard, checked before any await -- same pattern as
    // handleSaveThreshold's isSavingThresholdRef below.
    if (isReconnectingRef.current) return;
    isReconnectingRef.current = true;
    setIsReconnecting(true);
    setReconnectError(null);
    try {
      await httpClient.post('/auth/ado-credential', { adoOrgUrl: newOrgUrl, pat: newPat });
      // orgUrl is the only locally-cached field this touches -- the PAT
      // itself never enters authStore; the vault write already happened
      // server-side in the request above.
      useAuthStore.getState().login(newOrgUrl, displayName ?? '', userId ?? '', { email, accountName });
      showToast('Azure DevOps connection updated.', 'success');
      setReconnectOpen(false);
    } catch {
      setReconnectError('Invalid Azure DevOps organization URL or personal access token, or it belongs to a different Azure DevOps account.');
    } finally {
      isReconnectingRef.current = false;
      setIsReconnecting(false);
    }
  }

  function openSharePointReconnect(): void {
    setSharePointToken('');
    setSharePointReconnectError(null);
    setSharePointReconnectOpen(true);
  }

  async function handleSharePointReconnect(): Promise<void> {
    // Synchronous ref guard, checked before any await -- same pattern as
    // handleSaveThreshold's isSavingThresholdRef below.
    if (isSharePointReconnectingRef.current) return;
    isSharePointReconnectingRef.current = true;
    setIsSharePointReconnecting(true);
    setSharePointReconnectError(null);
    try {
      const status = await reconnectSharePoint(sharePointToken);
      if (status.status !== 'valid') {
        setSharePointReconnectError('SharePoint rejected that token. Check you copied the whole value — they are long.');
        return;
      }
      useConnectionStatusStore.getState().record('sharePoint', status);
      showToast('SharePoint reconnected.', 'success');
      setSharePointReconnectOpen(false);
    } catch {
      setSharePointReconnectError('SharePoint rejected that token. Check you copied the whole value — they are long.');
    } finally {
      isSharePointReconnectingRef.current = false;
      setIsSharePointReconnecting(false);
    }
  }

  function openLlmDialog(): void {
    // llmToken is deliberately NOT reset here -- kept in memory only (never
    // written to browser storage, matching this repo's own established rule
    // against holding a raw secret client-side, see authStore.ts's own
    // comment on why the ADO PAT was removed from sessionStorage) so
    // iterating on model selection within the same page load doesn't force
    // re-pasting the token on every reopen. Still cleared on a real page
    // refresh, same as before.
    setLlmModels([]);
    setLlmChatModel(llmConnection?.chatModel ?? '');
    setLlmConnectionError(null);
    setLlmDialogOpen(true);
    // Prefills the dropdowns from the caller's already-stored token (if
    // any), so re-opening this dialog to change just the model doesn't
    // force pasting the token again just to see the options -- Save itself
    // still requires re-entering it, same convention as the ADO/SharePoint
    // reconnect dialogs above.
    if (llmConnection?.configured) {
      setIsLoadingLlmModels(true);
      getLlmConnectionModels()
        .then(setLlmModels)
        .catch(() => undefined)
        .finally(() => setIsLoadingLlmModels(false));
    }
  }

  async function handleLoadLlmModels(): Promise<void> {
    if (isLoadingLlmModelsRef.current || !llmToken.trim()) return;
    isLoadingLlmModelsRef.current = true;
    setIsLoadingLlmModels(true);
    setLlmConnectionError(null);
    try {
      const models = await getLlmConnectionModels(llmToken.trim());
      setLlmModels(models);
    } catch {
      setLlmConnectionError('Could not validate this token against Open WebUI. Check it is correct and try again.');
    } finally {
      isLoadingLlmModelsRef.current = false;
      setIsLoadingLlmModels(false);
    }
  }

  async function handleSaveLlmConnection(): Promise<void> {
    if (isSavingLlmConnectionRef.current) return;
    isSavingLlmConnectionRef.current = true;
    setIsSavingLlmConnection(true);
    setLlmConnectionError(null);
    try {
      const saved = await setLlmConnection(llmToken.trim(), llmChatModel);
      const status = await getLlmConnection();
      setLlmConnectionState(status);
      // Flips RouteGuard's cached gate state directly -- without this, a
      // user who just configured their connection here would still get
      // bounced back to /settings by the gate's stale `configured: false`
      // the instant they click any other nav link, since RouteGuard only
      // re-checks once per session, not on every navigation.
      useLlmConnectionStore.getState().setConfigured(status.configured);
      showToast('Open WebUI connection saved.', 'success');
      // Saved either way (chat works without it), but the user should hear that matching against existing items will not run.
      if (saved?.embeddings === 'unavailable') {
        showToast('Duplicate detection cannot use this connection yet: your account cannot reach the embedding model. Ask whoever runs this system to give your account access to it.', 'warning');
      }
      setLlmDialogOpen(false);
    } catch {
      setLlmConnectionError('Could not save this connection. Check the token and selected models and try again.');
    } finally {
      isSavingLlmConnectionRef.current = false;
      setIsSavingLlmConnection(false);
    }
  }

  async function handleSaveThreshold(): Promise<void> {
    // Synchronous ref guard, checked before any await -- setIsSavingThreshold
    // hasn't re-rendered yet for a second click in the same tick.
    if (isSavingThresholdRef.current) return;
    const fraction = percentTextToFraction(thresholdPercent);
    if (fraction === null) {
      setThresholdError(THRESHOLD_RANGE_ERROR);
      return;
    }
    isSavingThresholdRef.current = true;
    setIsSavingThreshold(true);
    setThresholdError(null);
    try {
      const updated = await updateAppSettings(fraction);
      // Re-read from the server's own response rather than trusting the
      // local draft -- the stored value is the authority on what dedup_check
      // will actually use.
      const percentText = fractionToPercentText(updated.dedupThreshold);
      setThresholdPercent(percentText);
      setSavedThresholdPercent(percentText);
      showToast('Duplicate detection threshold saved.', 'success');
    } catch (error) {
      setThresholdError(isAxiosError(error) && error.response?.status === 403 ? THRESHOLD_FORBIDDEN_ERROR : THRESHOLD_SAVE_ERROR);
    } finally {
      isSavingThresholdRef.current = false;
      setIsSavingThreshold(false);
    }
  }

  const isThresholdUnavailable = !isThresholdLoading && savedThresholdPercent === null;
  const isThresholdDirty = savedThresholdPercent !== null && thresholdPercent.trim() !== savedThresholdPercent;
  const isThresholdValid = percentTextToFraction(thresholdPercent) !== null;

  const sharePointCopy = sharePointStatus ? SHAREPOINT_COPY[sharePointStatus.status] : null;
  const sharePointExpiry = sharePointStatus ? formatSharePointExpiry(sharePointStatus.expiresInSeconds) : null;

  const llmVisionModels = llmModels.filter((m) => m.vision);
  const llmAllVisionUnknown = llmModels.length > 0 && llmVisionModels.length === 0;
  const llmPickerModels = llmAllVisionUnknown ? llmModels : llmVisionModels;
  // Clear a stale selection whenever the filtered model list loads and no longer contains it.
  if (llmChatModel && llmPickerModels.length > 0 && !llmPickerModels.find((m) => m.id === llmChatModel)) {
    setLlmChatModel('');
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Profile and connections" />
      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
        <SectionCard title="Profile">
          <ProfileCard displayName={displayName} email={email} accountName={accountName} userId={userId} orgUrl={orgUrl} />
        </SectionCard>

        <div className="flex flex-col gap-4">
          <SectionCard title="Integrations">
            <div className="flex flex-col gap-2.5">
              <IntegrationRow
                icon={<Briefcase className="h-4 w-4" aria-hidden="true" />}
                name="Azure DevOps"
                // A healthy or still-checking connection says so in words beside the address (the failures say it below the row), so the
                // state is never carried by the colour of the chip alone.
                detail={adoRow.state === 'ok' || adoRow.state === 'checking' ? `${adoRow.word}${orgUrl ? ` · ${orgUrl}` : ''}` : (orgUrl ?? 'Not connected')}
                tone={ADO_TONE[adoRow.state]}
                reason={adoRow.state === 'attention' || adoRow.state === 'danger' ? adoRow.word : null}
                actionLabel="Reconnect"
                onAction={openReconnect}
              />
              {sharePointCopy && (
                <IntegrationRow
                  icon={<span className="text-xs font-bold">SP</span>}
                  name="SharePoint"
                  detail={sharePointCopy.label + (sharePointExpiry ? ` · ${sharePointExpiry}` : '')}
                  tone={sharePointCopy.tone}
                  reason={sharePointCopy.reason}
                  onAction={openSharePointReconnect}
                />
              )}
              {llmConnection && (
                <IntegrationRow
                  icon={<span className="text-xs font-bold">AI</span>}
                  name="Open WebUI"
                  detail={llmConnection.configured ? `Connected · ${llmConnection.chatModel}` : 'Not configured'}
                  tone={llmConnection.configured ? 'ok' : 'dim'}
                  onAction={openLlmDialog}
                />
              )}
            </div>
          </SectionCard>

          <SectionCard title="Display preferences">
            <div className="flex flex-col gap-3">
              <DisplayPreferenceRow
                label="Dense view"
                description="Reduce padding for data tables"
                checked={denseView}
                onCheckedChange={(value) => useUiPreferencesStore.getState().setDenseView(value)}
              />
              <DisplayPreferenceRow
                label="Auto-sync ledgers"
                description="Periodically fetch updates from Azure DevOps"
                checked={autoSyncLedgers}
                onCheckedChange={(value) => useUiPreferencesStore.getState().setAutoSyncLedgers(value)}
              />
              <DisplayPreferenceRow
                label="Keyboard shortcuts"
                description="Single-key shortcuts while reviewing: J, K, A, R, X, E and U"
                checked={keyboardShortcuts}
                onCheckedChange={(value) => useUiPreferencesStore.getState().setKeyboardShortcuts(value)}
              />
            </div>
          </SectionCard>

          <SectionCard title="Duplicate detection">
            {isThresholdLoading ? (
              <Skeleton className="h-8 w-full" />
            ) : (
              <div className="flex flex-col gap-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="flex items-center gap-1.5 text-sm font-medium text-ink-1">
                      Similarity threshold
                      <InfoTip content="Raise it and the system gets more conservative about calling two items duplicates: fewer items are skipped by mistake, but a real near-duplicate is likelier to slip through and be created a second time in Azure DevOps. Lower it and more items are skipped as duplicates, including ones you wanted created. Compared as a cosine similarity against work items already in the project." />
                    </p>
                    <p className="text-xs text-ink-3">
                      How alike two items must be to count as duplicates. A proposed item scoring at or above this against an existing work item is skipped instead of created.
                    </p>
                    <p className="text-xs text-ink-3">A second check confirms every match; if it cannot run, nothing is skipped.</p>
                  </div>
                  <div className="flex flex-none items-center gap-1.5">
                    <TextField
                      type="number"
                      min={THRESHOLD_PERCENT_MIN}
                      max={THRESHOLD_PERCENT_MAX}
                      step={1}
                      aria-label="Similarity threshold percentage"
                      value={thresholdPercent}
                      onChange={(e) => setThresholdPercent(e.target.value)}
                      disabled={isThresholdUnavailable || !canEditThreshold || isSavingThreshold}
                      className="w-[72px] text-right"
                    />
                    <span className="text-sm text-ink-2">%</span>
                  </div>
                </div>
                {embeddingModel && (
                  <p className="flex flex-wrap items-baseline gap-x-2 text-xs text-ink-3">
                    Similarity is measured with <span className="font-mono text-ink-2">{embeddingModel}</span>
                    <span>(set by whoever runs this system)</span>
                  </p>
                )}
                {!canEditThreshold && <p className="text-xs text-ink-3">Only an administrator can change this. Ask whoever runs this system.</p>}
                {thresholdError && <p className="text-sm text-danger">{thresholdError}</p>}
                <div className="flex justify-end">
                  <Button
                    size="sm"
                    onClick={handleSaveThreshold}
                    disabled={isThresholdUnavailable || !canEditThreshold || !isThresholdDirty || !isThresholdValid || isSavingThreshold}
                  >
                    {isSavingThreshold && <Spinner />}
                    Save threshold
                  </Button>
                </div>
              </div>
            )}
          </SectionCard>
        </div>
      </div>

      <Dialog
        open={reconnectOpen}
        onOpenChange={setReconnectOpen}
        title="Reconnect to Azure DevOps"
        description="Re-enter your organization URL and a valid Personal Access Token."
        footer={
          <>
            <span className="ml-auto" />
            <Button variant="ghost" onClick={() => setReconnectOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleReconnect} disabled={!newOrgUrl || !newPat || isReconnecting}>
              {isReconnecting && <Spinner />}
              Reconnect
            </Button>
          </>
        }
      >
        <TextField label="Azure DevOps organization URL" value={newOrgUrl} onChange={(e) => setNewOrgUrl(e.target.value)} fullWidth />
        <div className="flex items-end gap-1.5">
          <TextField label="Personal Access Token" type="password" value={newPat} onChange={(e) => setNewPat(e.target.value)} fullWidth />
          <InfoTip content="Needs Work Items (Read, write, & manage) scope at minimum. Reconnecting re-validates and re-encrypts this token server-side without signing you out." />
        </div>
        {reconnectError && <p className="text-sm text-danger">{reconnectError}</p>}
      </Dialog>

      <Dialog
        open={sharePointReconnectOpen}
        onOpenChange={setSharePointReconnectOpen}
        title="Reconnect SharePoint"
        description={SHAREPOINT_TOKEN_DIALOG_DESCRIPTION}
        footer={
          <>
            <span className="ml-auto" />
            <Button variant="ghost" onClick={() => setSharePointReconnectOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSharePointReconnect} disabled={!sharePointToken || isSharePointReconnecting}>
              {isSharePointReconnecting && <Spinner />}
              Reconnect
            </Button>
          </>
        }
      >
        <SharePointTokenHelp />
        <TextField label="SharePoint access token" type="password" value={sharePointToken} onChange={(e) => setSharePointToken(e.target.value)} fullWidth />
        {sharePointReconnectError && <p className="text-sm text-danger">{sharePointReconnectError}</p>}
      </Dialog>

      <Dialog
        open={llmDialogOpen}
        onOpenChange={setLlmDialogOpen}
        title="Configure Open WebUI"
        description="Your own API token and default models -- used for every job you submit and for chat. Never shared with other users."
        footer={
          <>
            <span className="ml-auto" />
            <Button variant="ghost" onClick={() => setLlmDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleSaveLlmConnection}
              disabled={!llmToken.trim() || !llmChatModel || llmModels.length === 0 || isSavingLlmConnection}
            >
              {isSavingLlmConnection && <Spinner />}
              Save
            </Button>
          </>
        }
      >
        <div className="flex items-end gap-1.5">
          <TextField
            label="Open WebUI API token"
            type="password"
            value={llmToken}
            onChange={(e) => setLlmToken(e.target.value)}
            fullWidth
          />
          <Button variant="outline" size="sm" onClick={handleLoadLlmModels} disabled={!llmToken.trim() || isLoadingLlmModels}>
            {isLoadingLlmModels && <Spinner />}
            Load models
          </Button>
        </div>
        <Select
          label="Model"
          labelExtra={
            <InfoTip
              content={
                llmAllVisionUnknown
                  ? 'No models report vision capability — showing all models.'
                  : 'Showing vision-capable models only.'
              }
            />
          }
          value={llmChatModel}
          onChange={(e) => setLlmChatModel(e.target.value)}
          disabled={llmPickerModels.length === 0}
          loading={isLoadingLlmModels}
          fullWidth
        >
          <option value="">Select a model…</option>
          {llmPickerModels.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </Select>
        {llmConnectionError && <p className="text-sm text-danger">{llmConnectionError}</p>}
      </Dialog>
    </div>
  );
}
