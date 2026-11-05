import { useId, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Alert } from '../ui/Alert';
import type { DocumentOverview } from '../api/jobs';
import { LABEL_MICRO } from '../utils/labelMicro';

const TEASER_CHARS = 150;
/** Lines shown before "Show all": enough to read what the file is, few enough that what follows (the Start button) stays near. */
export const OVERVIEW_LINES_SHOWN = 8;

/** One line that says what is inside: the AI summary's first sentence when there is one, else the structure line. */
function teaserOf(overview: DocumentOverview): string {
  // The structure line says more at a glance than a line about what the file lacks, which can come first.
  // A line that only says what the file lacks ("No Scope… section was found") is a poor one-line summary, so it comes last.
  const lines = overview.lines ?? [];
  const source =
    overview.aiSummary ||
    lines.find((line) => line.startsWith('Structure:')) ||
    lines.find((line) => line && !line.startsWith('No ')) ||
    lines.find(Boolean) ||
    overview.synopsis;
  const first = source.split(/(?<=[.!?])\s/)[0] || source;
  return first.length <= TEASER_CHARS ? first : `${first.slice(0, TEASER_CHARS - 1).trimEnd()}…`;
}

/**
 * The lines read off the file. The first few are shown, the rest on request, so a long list never pushes the page's next action away. Each line
 * takes its own text direction (Hebrew reads right to left) and wraps long unbroken strings.
 */
export function OverviewLines({ lines }: { lines: string[] }): React.ReactElement {
  const [all, setAll] = useState(false);
  const shown = all ? lines : lines.slice(0, OVERVIEW_LINES_SHOWN);
  return (
    <>
      <ul className="flex flex-col gap-1.5 text-sm text-ink-1">
        {shown.map((line, index) => (
          // the text can repeat, so the position is part of the key
          <li key={`${index}-${line}`} dir="auto" className="break-words">
            {line}
          </li>
        ))}
      </ul>
      {!all && lines.length > OVERVIEW_LINES_SHOWN && (
        <button type="button" onClick={() => setAll(true)} className="self-start text-xs font-medium text-ink-2 underline">
          Show all {lines.length} lines
        </button>
      )}
    </>
  );
}

/**
 * What the file is, kept out of the way: a job page is about the job's progress, so this card is one line until the reader opens it. Open, it
 * shows the AI summary first (labelled as a model's reading), then what was read off the file's text and structure.
 */
export function DocumentOverviewCard({ overview }: { overview: DocumentOverview }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const regionId = useId();
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <div className="mb-4 rounded-md border border-hairline bg-surface">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={regionId}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <Chevron className="h-3.5 w-3.5 flex-none text-ink-3" aria-hidden="true" />
        <span className={`${LABEL_MICRO} flex-none`}>Document overview</span>
        {!open && (
          // the button is named "Document overview"; the teaser is a preview for the eye, so it is not read as part of the name
          <span data-testid="overview-teaser" aria-hidden="true" className="min-w-0 flex-1 truncate text-xs text-ink-3">
            <bdi>{teaserOf(overview)}</bdi>
          </span>
        )}
        <span className="ml-auto flex-none text-xs font-medium text-ink-2">{open ? 'Hide' : 'Show'}</span>
      </button>
      {open && (
        <div id={regionId} className="flex flex-col gap-3 border-t border-hairline px-3 pb-3 pt-2">
          {overview.aiSummary && (
            <div className="flex flex-col gap-1">
              <span className="text-xs font-semibold text-ink-2">AI summary</span>
              <p dir="auto" className="break-words text-sm text-ink-1">{overview.aiSummary}</p>
              <span className="text-xs text-ink-3">Written by a model from the document’s headings and opening text. Check it against the file.</span>
            </div>
          )}
          <div className="flex flex-col gap-1">
            {overview.aiSummary && <span className="text-xs font-semibold text-ink-2">From the file’s text and structure</span>}
            {overview.lines && overview.lines.length > 0 ? (
              <OverviewLines lines={overview.lines} />
            ) : (
              <p dir="auto" className="break-words text-sm text-ink-1">{overview.synopsis}</p>
            )}
          </div>
          {overview.caveat && <Alert severity="warning">{overview.caveat}</Alert>}
        </div>
      )}
    </div>
  );
}
