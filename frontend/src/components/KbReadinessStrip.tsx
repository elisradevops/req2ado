import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getSharePointStatus, listIngestedDocuments, type IngestedDocument, type SharePointStatus } from '../api/kb';
import { useUserId } from '../store/authStore';
import { Chip } from '../ui/Chip';
import { Skeleton } from '../ui/Skeleton';

// SURVEY's honest answer to "will my knowledge base ground this run?",
// shown on the New Job configure step (review finding K6/F2) so a user
// learns BEFORE starting that grounding is off or degraded. Informational
// only -- never blocks submit (BASELINE and ungrounded SURVEY are valid).

const SHAREPOINT_COPY: Record<SharePointStatus['status'], { label: string; tone: 'ok' | 'warn' | 'muted' }> = {
  valid: { label: 'SharePoint connected', tone: 'ok' },
  invalid: { label: 'SharePoint token expired (adding files will fail)', tone: 'warn' },
  unreachable: { label: "Can't reach SharePoint (adding files will fail)", tone: 'warn' },
  not_configured: { label: 'SharePoint not connected', tone: 'muted' },
};

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'ready'; documents: IngestedDocument[]; sharePoint: SharePointStatus | null };

export function KbReadinessStrip(): React.ReactElement {
  const userId = useUserId();
  const [state, setState] = useState<LoadState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    Promise.all([
      listIngestedDocuments(userId ?? undefined),
      getSharePointStatus().catch((): SharePointStatus | null => null),
    ])
      .then(([documents, sharePoint]) => {
        if (!cancelled) setState({ kind: 'ready', documents, sharePoint });
      })
      .catch(() => {
        if (!cancelled) setState({ kind: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  if (state.kind === 'loading') {
    return (
      <div role="status" aria-label="Checking your knowledge base">
        <Skeleton className="h-5 w-56" />
      </div>
    );
  }
  if (state.kind === 'error') {
    return <p className="text-xs text-ink-3">Couldn't check your knowledge base right now.</p>;
  }

  const { documents, sharePoint } = state;
  // A file only grounds a run if it holds vectors. A count of 0 says it has none; a missing count (older ingests, or ones whose
  // vectors were lost) says nothing either way, so it is not counted as ready -- "6 files" must not include files we cannot vouch for.
  const noVectors = documents.filter((d) => d.chunkCount === 0).length;
  const unverified = documents.filter((d) => d.chunkCount == null).length;
  const ready = documents.filter((d) => (d.chunkCount ?? 0) > 0);
  const chunks = ready.reduce((sum, d) => sum + (d.chunkCount ?? 0), 0);
  const sp = sharePoint ? SHAREPOINT_COPY[sharePoint.status] : null;
  const sharePointBroken = sharePoint?.status === 'invalid' || sharePoint?.status === 'unreachable';
  // The Knowledge Base page is where all of these are fixed, so the link is offered only when there is something to fix there.
  const needsFix = documents.length === 0 || noVectors > 0 || unverified > 0 || sharePointBroken;
  // Said once, on the last file warning, and worded for however many files it covers in total.
  const reingest = `Re-ingest ${plural(noVectors + unverified, 'it', 'them')} in Knowledge Base (SharePoint folder).`;

  return (
    <div className="flex flex-col gap-1.5" aria-live="polite">
      <div className="flex flex-wrap items-center gap-2">
        {documents.length === 0 ? (
          <span className="text-xs text-warning-ink">
            Your knowledge base is empty — this run won't be grounded against your standards.
          </span>
        ) : (
          <Chip bg="var(--color-surface)" color="var(--color-ink-2)" className="border border-hairline-strong text-xs font-normal tabular-nums">
            {ready.length > 0
              ? `${ready.length} ${plural(ready.length, 'file', 'files')} · ${chunks} ${plural(chunks, 'chunk', 'chunks')}`
              : noVectors === 0
                ? `${unverified} ${plural(unverified, 'file', 'files')} · chunk count unknown` // older ingests: not known to be broken, just not confirmed
                : '0 files ready'}
          </Chip>
        )}
        {sp && (
          <Chip
            bg={sp.tone === 'warn' ? 'var(--color-warning-soft)' : 'var(--color-surface)'}
            color={sp.tone === 'warn' ? 'var(--color-warning-ink)' : 'var(--color-ink-3)'}
            className="h-auto max-w-full whitespace-normal rounded-md border border-hairline-strong text-xs font-normal"
          >
            {sp.label}
          </Chip>
        )}
        {needsFix && (
          <>
            <Link to="/knowledge-base" className="text-xs text-accent hover:underline">
              Fix in Knowledge Base
            </Link>
            <span className="text-xs text-ink-3">Your draft is kept.</span>
          </>
        )}
      </div>
      {noVectors > 0 && (
        <p className="text-xs text-warning-ink">
          {noVectors} {plural(noVectors, 'file has', 'files have')} no vectors and cannot ground this run.{unverified === 0 && ` ${reingest}`}
        </p>
      )}
      {unverified > 0 && (
        <p className="text-xs text-warning-ink">
          {unverified} {plural(unverified, 'file has', 'files have')} no stored chunk count, so {plural(unverified, 'it', 'they')} may not ground this run
          (older ingests, or ones whose vectors were lost). {reingest}
        </p>
      )}
      {sharePointBroken && <p className="text-xs text-warning-ink">Reconnect SharePoint in Knowledge Base before adding or re-ingesting files.</p>}
    </div>
  );
}
