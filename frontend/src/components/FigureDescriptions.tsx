import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Image } from 'lucide-react';
import { cn } from '../lib/cn';
import { Markdown } from '../ui/Markdown';
import { FigureImage } from './FigureImage';

export interface FigureDescriptionEntry {
  figureIndex: number;
  // Task 5: null for a figure the widened orchestrator filter now includes
  // because it has a NAME but no real caption (vision disabled/failed) --
  // "caption OR name" is the entry contract now, not "always has a
  // caption". See pipeline.worker.ts's own figureDescriptions comment.
  caption: string | null;
  // The document's own short title for this figure (Task 5) -- parsed
  // from a "Figure N: Title" caption line, or an LLM-generated fallback.
  // Distinct from `caption`, which is the vision model's prose
  // description. Null when neither source produced one.
  name: string | null;
  // Stable JobFigureFile key ("f0", "f1", ...) for this figure -- lets this
  // panel actually render the figure's image (FigureImage), not just its
  // text caption. figureIndex alone (a 1-based display ordinal) isn't a
  // storage key; JobDetail.tsx derives this from figureIndex using the
  // exact convention ingestion's main.py establishes (figure_id =
  // f"f{figureIndex - 1}") when it builds this array.
  figureId: string;
}

// The activity log (ProgressBanner) only ever shows the LATEST narration
// plus a 160-char-truncated preview of each message -- a document with
// dozens of figures otherwise has no way to read any vision-model caption
// in full once a later event pushes it out of view. This panel keeps every
// distinct figure's full caption for as long as the job page stays open,
// live from SSE narration during a run, seeded from the persisted
// Job.figureDescriptions column on mount otherwise -- so it survives a
// reload or reopening a completed job (see JobDetail.tsx's loadJob).
// Collapsed-by-default, same pattern as CollapsibleWarnings.
export function FigureDescriptions({ jobId, items }: { jobId: string; items: FigureDescriptionEntry[] }): React.ReactElement | null {
  const [expanded, setExpanded] = useState(false);
  // Tracks whether this panel has EVER been expanded, distinct from
  // `expanded` itself -- gates FigureImage's lazy fetch (see its own doc
  // comment) so images load once, the first time the reviewer actually
  // opens this panel, and stay loaded (not re-fetched) if they collapse and
  // reopen it. Starting this fetch on every render regardless of collapse
  // state would mean pulling every figure in the document up front, most of
  // the time for nothing.
  const [hasExpandedOnce, setHasExpandedOnce] = useState(false);
  useEffect(() => {
    if (expanded) setHasExpandedOnce(true);
  }, [expanded]);
  if (items.length === 0) return null;

  return (
    <div className="overflow-hidden rounded-sm border border-hairline bg-surface">
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left text-sm text-ink-2"
      >
        {expanded ? <ChevronDown className="h-4 w-4 flex-none" /> : <ChevronRight className="h-4 w-4 flex-none" />}
        <Image className="h-4 w-4 flex-none" aria-hidden="true" />
        <span className="font-medium">
          {items.length} figure description{items.length === 1 ? '' : 's'}
        </span>
        <span className="text-ink-3">-- full vision-model output for each embedded figure</span>
      </button>
      <div className={cn('grid min-h-0 transition-[grid-template-rows] duration-200 ease-out', expanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]')}>
        <div className="min-h-0 overflow-hidden">
          <ul className="flex flex-col gap-2 border-t border-hairline px-3.5 py-2.5">
            {items.map((item, position) => (
              <li key={item.figureIndex} className="flex flex-col gap-2 border-t border-hairline/60 pt-2 text-sm text-ink-2 first:border-t-0 first:pt-0 sm:flex-row sm:items-start">
                {/* The actual figure, not just a text description of it --
                    previously this panel was caption-only, so a diagram
                    referenced only as "Figure: This diagram illustrates..."
                    had no way to be seen, only read about. */}
                <FigureImage jobId={jobId} figureId={item.figureId} active={hasExpandedOnce} alt={item.name || `Figure ${position + 1}`} />
                {/* Final whole-branch review finding: [&_p]:!text-ink-2 targets
                    Markdown's own rendered <p> directly (an !important class
                    on this ancestor div never wins against the <p>'s own
                    explicit classes -- importance only competes between
                    declarations on the SAME element). text-sm needs no
                    override here -- it already matches Markdown's own p
                    default, unlike NodeDetailPanel's site which needs xs.
                    [&_p]:inline keeps the "Figure N: " label and the caption
                    on the same line -- Markdown's <p> is block-level by
                    default, which (before this) pushed the caption onto its
                    own line below the label, an unintended layout regression
                    from the prior plain-text-in-<p> rendering. */}
                <div className="min-w-0 flex-1 [&_p]:inline [&_p]:!text-ink-2">
                  {/* Display position (1, 2, 3...), NOT item.figureIndex --
                      figureIndex is this figure's real 1-based position among
                      ALL raw images in the document, INCLUDING ones filtered
                      out entirely (degenerate 2x2 rendering artifacts) or
                      excluded as insignificant/failed (never added to
                      `items` at all -- see JobDetail.tsx's figureCaptionStatus
                      exclusion). Labeling by that real index looks like a
                      numbering bug once enough early figures are excluded --
                      confirmed live: a reviewer's very first VISIBLE entry
                      was labeled "Figure 13", not "Figure 1", even though it
                      genuinely was the first one shown. `items` is already
                      sorted by figureIndex (JobDetail.tsx's own useMemo), so
                      array position IS the correct sequential display order --
                      figureIndex/figureId stay unchanged for the FigureImage
                      lookup and NodeDetailPanel's own figureId-keyed
                      captionByFigureId map, which must still key by the real
                      id. */}
                  {/* Task 5: the document's own name replaces the bare
                      "Figure N" ordinal label when present -- falls back to
                      the same position-based label as before when the
                      document provided no caption line of its own (and no
                      LLM title fallback fired either). */}
                  <span className="font-medium text-ink-1">{item.name || `Figure ${position + 1}`}: </span>
                  {/* A name-only entry (Task 5's widened filter) has no
                      caption text to render -- show just the name label
                      above, no empty Markdown block underneath it. */}
                  {item.caption != null && <Markdown>{item.caption}</Markdown>}
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
