import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Image } from 'lucide-react';
import { cn } from '../lib/cn';
import { Markdown } from '../ui/Markdown';
import { FigureImage } from './FigureImage';

export interface FigureDescriptionEntry {
  figureIndex: number;
  caption: string;
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
            {items.map((item) => (
              <li key={item.figureIndex} className="flex flex-col gap-2 border-t border-hairline/60 pt-2 text-sm text-ink-2 first:border-t-0 first:pt-0 sm:flex-row sm:items-start">
                {/* The actual figure, not just a text description of it --
                    previously this panel was caption-only, so a diagram
                    referenced only as "Figure: This diagram illustrates..."
                    had no way to be seen, only read about. */}
                <FigureImage jobId={jobId} figureId={item.figureId} active={hasExpandedOnce} alt={`Figure ${item.figureIndex}`} />
                <div className="min-w-0 flex-1 !text-ink-2">
                  <span className="font-medium text-ink-1">Figure {item.figureIndex}: </span>
                  <Markdown>{item.caption}</Markdown>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
