import { create } from 'zustand';
import { isAxiosError } from 'axios';
import {
  cancelKbIngestBatch,
  createKbIngestBatch,
  getKbIngestBatch,
  listKbIngestBatches,
  resumeKbIngestBatch,
  retryFailedKbIngestBatch,
  type CreateKbIngestBatchInput,
  type KbIngestBatch,
  type KbIngestBatchStatus,
} from '../api/kb';

// The knowledge-base batch the user is adding files with. The work runs on the server (it survives a closed tab and a
// restart), so this holds no queue of its own: it shows what the server says, polling while the batch is going. The server
// is the source of truth, so a reload simply finds the batch again (attach), and nothing is kept in browser storage.
//
// Module-level, not component state: the page can unmount mid-batch (the user navigates away) without losing the batch, and
// whatever the user was looking at is still there when they come back.

const POLL_MS = 3_000;
const FINISHED: KbIngestBatchStatus[] = ['completed', 'completed_with_errors', 'failed', 'cancelled'];

export function isBatchStatusFinished(status: KbIngestBatchStatus): boolean {
  return FINISHED.includes(status);
}

export function isBatchFinished(batch: KbIngestBatch): boolean {
  return isBatchStatusFinished(batch.status);
}

interface KbIngestState {
  // The batch on show: the one running, or one that just finished (kept until dismissed, so its report can be read).
  batch: KbIngestBatch | null;
  // Whose batch it is, so the next user to sign in on this tab never sees it.
  ownerId: string | null;
  // The last problem talking to the server, in words; null when the last request went through.
  error: string | null;
  // A user action (adding, cancelling, retrying, resuming) is on its way.
  busy: boolean;
  // Finds the batch the user already has going, after a reload or coming back to the page.
  attach: (userId: string) => Promise<void>;
  // Creates a batch and follows it. Rejects when the server refuses, so the dialog can say why.
  submit: (userId: string, input: CreateKbIngestBatchInput) => Promise<void>;
  cancel: () => Promise<void>;
  retryFailed: () => Promise<void>;
  resume: () => Promise<void>;
  dismiss: () => void;
  // Stops following (the page is gone); the batch itself carries on on the server.
  stop: () => void;
  reset: () => void;
}

let timer: ReturnType<typeof setTimeout> | undefined;
let listening = false;
// Bumped whenever the batch on show changes identity, so an answer to an old request is recognised and dropped.
let generation = 0;

export const useKbIngestStore = create<KbIngestState>((set, get) => {
  function clearTimer(): void {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  }

  function onVisible(): void {
    const { batch } = get();
    if (document.visibilityState === 'visible' && batch && !isBatchFinished(batch)) {
      clearTimer();
      void poll();
    }
  }

  function stopFollowing(): void {
    clearTimer();
    if (listening) {
      document.removeEventListener('visibilitychange', onVisible);
      listening = false;
    }
  }

  function schedule(): void {
    clearTimer();
    timer = setTimeout(() => void poll(), POLL_MS);
  }

  function follow(): void {
    const { batch } = get();
    if (!batch || isBatchFinished(batch)) {
      stopFollowing();
      return;
    }
    if (!listening) {
      document.addEventListener('visibilitychange', onVisible);
      listening = true;
    }
    schedule();
  }

  async function poll(): Promise<void> {
    const current = get().batch;
    if (!current) return;
    if (document.visibilityState !== 'visible') {
      schedule(); // nothing is looking: wait, and ask the moment it is
      return;
    }
    const mine = generation;
    try {
      const fresh = await getKbIngestBatch(current.id);
      if (mine !== generation || get().batch?.id !== current.id) return;
      set({ batch: fresh, error: null });
    } catch (error) {
      if (mine !== generation) return;
      if (isAxiosError(error) && error.response?.status === 404) {
        // Forgotten by the server (finished batches are removed after a while).
        stopFollowing();
        set({ batch: null, error: null });
        return;
      }
      set({ error: 'Could not refresh the batch status. Retrying.' });
    }
    follow();
  }

  async function act(call: (id: string) => Promise<KbIngestBatch>): Promise<void> {
    const current = get().batch;
    if (!current || get().busy) return;
    const mine = generation;
    set({ busy: true });
    try {
      const updated = await call(current.id);
      if (mine === generation) {
        set({ batch: updated, error: null });
        follow();
      }
    } catch {
      set({ error: 'Could not update the batch. Try again.' });
    } finally {
      set({ busy: false });
    }
  }

  const initial = { batch: null, ownerId: null, error: null, busy: false };

  return {
    ...initial,

    attach: async (userId) => {
      if (get().ownerId !== null && get().ownerId !== userId) {
        stopFollowing();
        generation += 1;
        set({ ...initial });
      }
      set({ ownerId: userId });
      // The batch on show may change while these requests are on their way (the user adds files, or dismisses the report): a
      // late answer must not put an older batch back over it.
      const mine = generation;
      try {
        const [active] = await listKbIngestBatches({ active: true, limit: 1 });
        if (mine !== generation) return;
        if (!active) {
          follow(); // a batch already on show may still be running
          return;
        }
        // A list leaves the files out.
        const full = await getKbIngestBatch(active.id);
        if (mine !== generation) return;
        generation += 1;
        set({ batch: full, error: null });
        follow();
      } catch {
        // Nothing to attach to is not an error the page has to deal with.
      }
    },

    submit: async (userId, input) => {
      set({ busy: true });
      try {
        const created = await createKbIngestBatch(input);
        generation += 1;
        set({ batch: created, ownerId: userId, error: null });
        follow();
      } finally {
        set({ busy: false });
      }
    },

    cancel: () => act(cancelKbIngestBatch),
    retryFailed: () => act(retryFailedKbIngestBatch),
    resume: () => act(resumeKbIngestBatch),

    dismiss: () => {
      stopFollowing();
      generation += 1;
      set({ batch: null, error: null });
    },

    stop: () => stopFollowing(),

    reset: () => {
      stopFollowing();
      generation += 1;
      set({ ...initial });
    },
  };
});
