import { useState } from 'react';
import { ChevronDown, ChevronRight, Image } from 'lucide-react';
import { cn } from '../lib/cn';

export interface FigureDescriptionEntry {
  figureIndex: number;
  caption: string;
}

// The activity log (ProgressBanner) only ever shows the LATEST narration
// plus a 160-char-truncated preview of each message -- a document with
// dozens of figures otherwise has no way to read any vision-model caption
// in full once a later event pushes it out of view. This panel keeps every
// distinct figure's full caption for as long as the job page stays open
// (not persisted -- reloading the page loses it, same as the rest of the
// live narration state), same collapsed-by-default pattern as
// CollapsibleWarnings.
export function FigureDescriptions({ items }: { items: FigureDescriptionEntry[] }): React.ReactElement | null {
  const [expanded, setExpanded] = useState(false);
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
              <li key={item.figureIndex} className="text-sm text-ink-2 border-t border-hairline/60 pt-2 first:border-t-0 first:pt-0">
                <span className="font-medium text-ink-1">Figure {item.figureIndex}: </span>
                {item.caption}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
