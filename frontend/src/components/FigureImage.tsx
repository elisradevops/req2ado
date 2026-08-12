import { useEffect, useState } from 'react';
import { ImageOff } from 'lucide-react';
import { getFigureFile } from '../api/jobs';

// A figure's fetch/render state, modeled as a discriminated union (not a
// separate loading/error/blob-url trio of booleans+nullables) so an
// invalid combination -- e.g. both "loading" and "ready" at once -- is
// unrepresentable rather than merely unreachable.
type FigureImageState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; url: string }
  | { status: 'missing' }
  | { status: 'error' };

// Lazily fetches ONE figure's stored bytes (JobFigureFile, via the
// session-authed GET /jobs/:id/figures/:figureId route) and renders it as
// an <img> -- the actual image the product owner asked to SEE, alongside
// the vision-model's text caption FigureDescriptions/NodeDetailPanel
// already show. Fetches only once `active` first turns true, not on mount
// unconditionally: FigureDescriptions stays collapsed by default and its
// items remain in the DOM even while collapsed (see that component's own
// grid-rows animation comment), so an unconditional fetch would eagerly
// pull every figure in the document on page load regardless of whether the
// reviewer ever opens the panel. Once fetched, the result is cached in
// this component's own state for its lifetime -- re-collapsing/
// re-expanding the parent does not re-fetch.
export function FigureImage({
  jobId,
  figureId,
  active,
  alt,
}: {
  jobId: string;
  figureId: string;
  active: boolean;
  alt: string;
}): React.ReactElement {
  const [state, setState] = useState<FigureImageState>({ status: 'idle' });

  useEffect(() => {
    if (!active || state.status !== 'idle') return;
    let cancelled = false;
    setState({ status: 'loading' });
    getFigureFile(jobId, figureId)
      .then((blob) => {
        if (cancelled) return;
        // null (not an error) means the figure was never stored, or was
        // already attached to ADO and deleted server-side on success (see
        // JobsService.attachFigureToAdo) -- a normal, expected state.
        setState(blob ? { status: 'ready', url: URL.createObjectURL(blob) } : { status: 'missing' });
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'error' });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately excludes state.status: only `active` first turning true should trigger a (re-)fetch, not every render.
  }, [active, jobId, figureId]);

  // Revokes the previous object URL whenever this component unmounts or a
  // fresh one replaces it -- otherwise every fetched figure's blob stays
  // pinned in memory for the rest of the page's life.
  useEffect(() => {
    if (state.status !== 'ready') return;
    const { url } = state;
    return () => URL.revokeObjectURL(url);
  }, [state]);

  if (state.status === 'ready') {
    return (
      // min-w-0 is load-bearing, not decorative -- this renders as a DIRECT
      // flex child of the figure card's `sm:flex-row` row (NodeDetailPanel's
      // Figures section). A flex item's default min-width is `auto`, which
      // floors it at its own content's intrinsic size -- for a replaced
      // element like <img>, that's the SOURCE IMAGE'S NATIVE width, so
      // `max-w-full` (100% of a box that itself never shrinks below that
      // native width) was a no-op: a wide source image pushed the whole
      // row wider instead of shrinking, squeezing the caption text next to
      // it into a near-unreadable single-word-per-line column (confirmed
      // real, reported live). `min-w-0` lets this box actually shrink
      // below its content size, which is what makes max-w-full/max-h-64
      // below actually bound the rendered size instead of only bounding an
      // already-oversized box.
      <img
        src={state.url}
        alt={alt}
        className="max-h-64 w-auto min-w-0 max-w-full flex-none rounded-sm border border-hairline object-contain sm:max-w-xs"
      />
    );
  }
  if (state.status === 'loading' || state.status === 'idle') {
    return (
      <div className="flex h-24 w-40 flex-none items-center justify-center rounded-sm border border-hairline bg-surface-alt text-xs text-ink-3">
        Loading…
      </div>
    );
  }
  return (
    <div className="flex h-24 w-40 flex-none flex-col items-center justify-center gap-1 rounded-sm border border-hairline bg-surface-alt px-2 text-center text-xs text-ink-3">
      <ImageOff className="h-4 w-4 flex-none" aria-hidden="true" />
      {state.status === 'missing' ? 'Image no longer available' : 'Failed to load image'}
    </div>
  );
}
