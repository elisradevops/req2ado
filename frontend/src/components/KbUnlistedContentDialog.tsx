import { useEffect, useState } from 'react';
import { isAxiosError } from 'axios';
import { reconcileKbOrphans, type KbOrphanSource, type KbReconcileResult } from '../api/kb';
import { Alert } from '../ui/Alert';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Spinner } from '../ui/Spinner';
import { plural } from '../utils/plural';

// Content can stay stored in the knowledge base without appearing in the document list (an earlier version of the app, or a save that failed
// half-way). It cannot be removed from the list, yet SURVEY jobs still read it, next to the current copy of the same file. This checks for it
// when opened (nothing is changed), shows what it found, and removes it only when the user confirms.

type Phase =
  | { kind: 'checking' }
  | { kind: 'found'; orphans: KbOrphanSource[] }
  | { kind: 'none' }
  | { kind: 'removing'; orphans: KbOrphanSource[] }
  | { kind: 'done'; result: KbReconcileResult }
  | { kind: 'error'; message: string; orphans?: KbOrphanSource[] };

function describeError(error: unknown, doing: 'check' | 'remove'): string {
  if (isAxiosError(error) && error.response?.status === 409) {
    return 'Files are still being added to the knowledge base. Wait for them to finish, or cancel them, then try again.';
  }
  return doing === 'check' ? "Couldn't check the knowledge base. Try again in a moment." : "Couldn't remove everything. Try again in a moment.";
}

const labelOf = (orphan: KbOrphanSource): string =>
  orphan.fileNames.length > 0 ? orphan.fileNames.join(', ') : 'Content with no file name recorded';

function OrphanList({ orphans }: { orphans: KbOrphanSource[] }): React.ReactElement {
  return (
    <ul aria-label="Unlisted content" className="flex max-h-60 flex-col divide-y divide-hairline overflow-y-auto text-sm">
      {orphans.map((orphan) => (
        <li key={orphan.sourceId ?? 'no-source'} className="flex items-baseline gap-3 py-1.5">
          <span dir="auto" className="min-w-0 flex-1 truncate font-medium text-ink-1">
            {labelOf(orphan)}
          </span>
          {orphan.chunks > 0 && <span className="flex-none text-xs text-ink-3">{plural(orphan.chunks, 'chunk')}</span>}
        </li>
      ))}
    </ul>
  );
}

export function KbUnlistedContentDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }): React.ReactElement {
  const [phase, setPhase] = useState<Phase>({ kind: 'checking' });

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setPhase({ kind: 'checking' });
    reconcileKbOrphans(true)
      .then((result) => {
        if (!cancelled) setPhase(result.orphans.length > 0 ? { kind: 'found', orphans: result.orphans } : { kind: 'none' });
      })
      .catch((error: unknown) => {
        if (!cancelled) setPhase({ kind: 'error', message: describeError(error, 'check') });
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  async function remove(orphans: KbOrphanSource[]): Promise<void> {
    setPhase({ kind: 'removing', orphans });
    try {
      setPhase({ kind: 'done', result: await reconcileKbOrphans(false) });
    } catch (error) {
      setPhase({ kind: 'error', message: describeError(error, 'remove'), orphans });
    }
  }

  const busy = phase.kind === 'checking' || phase.kind === 'removing';
  const orphansToRemove = phase.kind === 'found' ? phase.orphans : phase.kind === 'error' ? phase.orphans : undefined;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !busy && onOpenChange(next)}
      title="Check for unlisted content"
      description="Stored content that is missing from your document list can still be read by SURVEY jobs, next to the current copy of the same file."
      footer={
        <>
          <span className="ml-auto" />
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            {phase.kind === 'found' || phase.kind === 'error' ? 'Cancel' : 'Close'}
          </Button>
          {orphansToRemove && (
            <Button variant="danger" onClick={() => void remove(orphansToRemove)}>
              {phase.kind === 'error' ? 'Try again' : `Remove ${plural(orphansToRemove.length, 'item')}`}
            </Button>
          )}
        </>
      }
    >
      {phase.kind === 'checking' && (
        <p className="flex items-center gap-2 text-sm text-ink-2">
          <Spinner /> Checking…
        </p>
      )}
      {phase.kind === 'none' && <p className="text-sm text-ink-2">Nothing unlisted found. Everything stored in your knowledge base is in your document list.</p>}
      {(phase.kind === 'found' || phase.kind === 'removing') && (
        <>
          <p className="text-sm text-ink-2">
            Found {plural(phase.orphans.length, 'item')} stored but not in your list. Removing {phase.orphans.length === 1 ? 'it' : 'them'} deletes the stored content and cannot be undone. Files in your list are not touched.
          </p>
          <OrphanList orphans={phase.orphans} />
          {phase.kind === 'removing' && (
            <p className="flex items-center gap-2 text-sm text-ink-2">
              <Spinner /> Removing…
            </p>
          )}
        </>
      )}
      {phase.kind === 'done' && (
        <>
          <p className="text-sm text-ink-2">Removed {plural(phase.result.removed, 'item')}.</p>
          {phase.result.failed.length > 0 && (
            <Alert severity="warning">
              {plural(phase.result.failed.length, 'item')} could not be removed. Run the check again to retry.
              <OrphanList orphans={phase.result.failed.map((f) => ({ ...f, chunks: 0 }))} />
            </Alert>
          )}
        </>
      )}
      {phase.kind === 'error' && <Alert severity="error">{phase.message}</Alert>}
    </Dialog>
  );
}
