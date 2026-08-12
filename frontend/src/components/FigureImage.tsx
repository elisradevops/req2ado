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

// Real, confirmed race (reported live, during an in-progress SURVEY run
// with this panel already expanded): ingestion publishes a figure's SSE
// narration event (caption text, which is what makes FigureDescriptions
// render this figure's row and flip `active` to true) BEFORE it makes its
// own separate HTTP call to store that figure's compressed bytes on
// orchestrator (see ingestion/app/main.py's _describe_figure_with_progress
// -- narration publish happens first, _figure_file_client.store() second).
// A fetch that fires the instant `active` turns true can beat that store
// call to orchestrator and get a real, honest 404 for a figure that WILL
// exist a moment later -- previously cached as a terminal "missing" state
// with no way to recover short of a full page refresh (which re-mounts the
// component well after storage has caught up). A few retries with a short,
// fixed delay absorbs this normal, bounded network race without turning a
// GENUINELY missing figure (attached-then-deleted, or storage failed) into
// an infinite retry loop.
const _MISSING_RETRY_ATTEMPTS = 3;
const _MISSING_RETRY_DELAY_MS = 1500;

function _delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
    // A null result on the FIRST attempt is genuinely ambiguous -- see
    // _MISSING_RETRY_ATTEMPTS' own comment -- so it's retried a few times
    // before being trusted as a real, stable "missing" rather than a
    // storage-write-still-in-flight race. Retries stay entirely inside
    // this one effect run (not a second useEffect firing) so `cancelled`
    // correctly aborts an in-flight retry loop too, same as the original
    // single-shot fetch.
    async function fetchWithRetry(): Promise<void> {
      for (let attempt = 0; attempt <= _MISSING_RETRY_ATTEMPTS; attempt++) {
        // A real 0ms delay on the first attempt, not a skipped one --
        // behaviorally identical (a 0ms setTimeout is still effectively
        // immediate), but keeps every attempt going through the exact same
        // await-a-timer path, which is what actually makes this reliably
        // testable with fake timers (a microtask with no timer anywhere in
        // its chain can't be advanced-to by a fake-timer clock at all).
        await _delay(attempt === 0 ? 0 : _MISSING_RETRY_DELAY_MS);
        if (cancelled) return;
        const blob = await getFigureFile(jobId, figureId);
        if (cancelled) return;
        if (blob) {
          setState({ status: 'ready', url: URL.createObjectURL(blob) });
          return;
        }
        // null (not an error) means the figure was never stored, was
        // already attached to ADO and deleted server-side on success (see
        // JobsService.attachFigureToAdo), or -- the case this retry loop
        // exists for -- ingestion's own storage HTTP call simply hasn't
        // reached orchestrator yet. Keep retrying until the attempt budget
        // is exhausted; only then is "missing" treated as final.
      }
      if (!cancelled) setState({ status: 'missing' });
    }
    fetchWithRetry().catch(() => {
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
      // below its content size, which is what makes max-w-full/h-40
      // below actually bound the rendered size instead of only bounding an
      // already-oversized box.
      //
      // `h-40` (a FIXED height, not just a max) is the other half of this:
      // these are line diagrams/schematics captured from a source document,
      // and some are genuinely low-resolution (a small pasted screenshot).
      // The previous `w-auto` sizing meant the <img> rendered at its own
      // NATIVE pixel size with only an upper bound -- correct for an
      // oversized image, but left a small one looking lost/illegibly tiny
      // inside a much larger card (confirmed real, reported live). A fixed
      // height decouples the rendered BOX from the image's own intrinsic
      // size, so `object-contain` can scale the real image content to FILL
      // that box on both ends -- shrinking an oversized image exactly as
      // before, but also enlarging an undersized one up to a legible floor,
      // always preserving aspect ratio (letterboxed on the shorter axis
      // when the source doesn't match the box's proportions, never
      // stretched/distorted).
      <img
        src={state.url}
        alt={alt}
        className="h-40 w-full min-w-0 max-w-full flex-none rounded-sm border border-hairline object-contain sm:max-w-xs"
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
