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
  const noVectors = documents.filter((d) => d.chunkCount === 0).length;
  // Unknown (legacy null) counts are never summed as 0: the chunk total is
  // shown only when every file's count is known.
  const allCountsKnown = documents.every((d) => d.chunkCount != null);
  const chunks = documents.reduce((sum, d) => sum + (d.chunkCount ?? 0), 0);
  const sp = sharePoint ? SHAREPOINT_COPY[sharePoint.status] : null;

  return (
    <div className="flex flex-col gap-1.5" aria-live="polite">
      <div className="flex flex-wrap items-center gap-2">
        {documents.length === 0 ? (
          <span className="text-xs text-warning-ink">
            Your knowledge base is empty — this run won't be grounded against your standards.
          </span>
        ) : (
          <Chip bg="var(--color-surface)" color="var(--color-ink-2)" className="border border-hairline-strong text-xs font-normal tabular-nums">
            {documents.length} {plural(documents.length, 'file', 'files')}
            {allCountsKnown && ` · ${chunks} ${plural(chunks, 'chunk', 'chunks')}`}
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
        <Link to="/knowledge-base" className="text-xs text-accent hover:underline">
          Manage knowledge base
        </Link>
      </div>
      {noVectors > 0 && (
        <p className="text-xs text-warning-ink">
          {noVectors} {plural(noVectors, 'file has', 'files have')} no vectors and cannot ground this run — re-ingest {plural(noVectors, 'it', 'them')}
        </p>
      )}
    </div>
  );
}
