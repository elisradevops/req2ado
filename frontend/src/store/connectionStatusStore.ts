import { create } from 'zustand';
import { getAdoStatus, type AdoStatus } from '../api/ado';
import { getSharePointStatus, type SharePointStatus } from '../api/kb';
import { getLlmStatus, type LlmStatus } from '../api/llm';

// One shared source for "is Azure DevOps / SharePoint / the LLM backend usable", replacing four
// independent one-time fetches (the rail, the KB readiness strip, the KB page, Settings) that could
// disagree with each other and never refreshed. The checks are the same live probes as before; this
// only decides when they run and who sees the result.

export type ConnectionKind = 'ado' | 'sharePoint' | 'llm';

export interface StatusEntry<T> {
  // The last status that was successfully read; kept when a later check fails.
  data: T | null;
  // The most recent check could not be completed (network or server error): a consumer decides what
  // that means for it, the store does not turn it into a status.
  error: boolean;
  checkedAt: number | null;
  inFlight: boolean;
}

interface ConnectionStatusState {
  ado: StatusEntry<AdoStatus>;
  sharePoint: StatusEntry<SharePointStatus>;
  llm: StatusEntry<LlmStatus>;
  // Checks one integration, or all three. A check already in flight is joined, not repeated.
  refresh: (kind?: ConnectionKind) => Promise<void>;
  // Stores a status the caller already has from the server (a reconnect's own answer), without another check.
  record: <K extends ConnectionKind>(kind: K, data: NonNullable<ConnectionStatusState[K]['data']>) => void;
  reset: () => void;
}

function emptyEntry<T>(): StatusEntry<T> {
  return { data: null, error: false, checkedAt: null, inFlight: false };
}

// Resolved at call time (not captured at import) so a test that replaces an API function is honoured.
const FETCHERS: { [K in ConnectionKind]: () => Promise<unknown> } = {
  ado: () => getAdoStatus(),
  sharePoint: () => getSharePointStatus(),
  llm: () => getLlmStatus(),
};

const KINDS: ConnectionKind[] = ['ado', 'sharePoint', 'llm'];
const inFlight: Partial<Record<ConnectionKind, Promise<void>>> = {};

export const useConnectionStatusStore = create<ConnectionStatusState>((set) => {
  function check(kind: ConnectionKind): Promise<void> {
    const running = inFlight[kind];
    if (running) return running;
    set((state) => ({ [kind]: { ...state[kind], inFlight: true } }) as Partial<ConnectionStatusState>);
    const promise = Promise.resolve()
      .then(() => FETCHERS[kind]())
      .then(
      (data) => {
        set({ [kind]: { data, error: false, checkedAt: Date.now(), inFlight: false } } as Partial<ConnectionStatusState>);
      },
      () => {
        set((state) => ({ [kind]: { ...state[kind], error: true, checkedAt: Date.now(), inFlight: false } }) as Partial<ConnectionStatusState>);
      },
    );
    inFlight[kind] = promise.finally(() => {
      delete inFlight[kind];
    });
    return inFlight[kind] as Promise<void>;
  }

  return {
    ado: emptyEntry(),
    sharePoint: emptyEntry(),
    llm: emptyEntry(),
    refresh: async (kind) => {
      await Promise.all((kind ? [kind] : KINDS).map(check));
    },
    record: (kind, data) => {
      set({ [kind]: { data, error: false, checkedAt: Date.now(), inFlight: false } } as Partial<ConnectionStatusState>);
    },
    reset: () => {
      for (const key of KINDS) delete inFlight[key];
      set({ ado: emptyEntry(), sharePoint: emptyEntry(), llm: emptyEntry() });
    },
  };
});

const POLL_INTERVAL_MS = 60_000;
const BACKOFF_INTERVALS_MS = [120_000, 300_000];
// A tab brought back to the foreground re-checks only when what it shows is older than this.
const STALE_AFTER_MS = 15_000;

function anyFailed(): boolean {
  const { ado, sharePoint, llm } = useConnectionStatusStore.getState();
  return [ado, sharePoint, llm].some((entry) => entry.error);
}

function isStale(): boolean {
  const { ado, sharePoint, llm } = useConnectionStatusStore.getState();
  return [ado, sharePoint, llm].some((entry) => entry.checkedAt === null || Date.now() - entry.checkedAt > STALE_AFTER_MS);
}

/**
 * Keeps the store fresh: a check now, then one every 60 s while the tab is visible, backing off to
 * 120 s and then 300 s while a check keeps failing (a down backend is not worth hammering), and
 * returning to 60 s once everything succeeds. A tab that was hidden or unfocused re-checks when it
 * comes back, if its data is stale. Returns the function that stops it.
 */
export function startConnectionStatusPolling(): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  let stopped = false;

  function schedule(): void {
    if (stopped) return;
    const delay = failures === 0 ? POLL_INTERVAL_MS : BACKOFF_INTERVALS_MS[Math.min(failures, BACKOFF_INTERVALS_MS.length) - 1];
    timer = setTimeout(() => void tick(), delay);
  }

  async function tick(): Promise<void> {
    if (stopped) return;
    if (document.visibilityState === 'visible') {
      await useConnectionStatusStore.getState().refresh();
      failures = anyFailed() ? failures + 1 : 0;
    }
    schedule();
  }

  function recheckIfStale(): void {
    if (stopped || document.visibilityState !== 'visible' || !isStale()) return;
    void useConnectionStatusStore.getState().refresh();
  }

  document.addEventListener('visibilitychange', recheckIfStale);
  window.addEventListener('focus', recheckIfStale);
  void tick();

  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    document.removeEventListener('visibilitychange', recheckIfStale);
    window.removeEventListener('focus', recheckIfStale);
  };
}
