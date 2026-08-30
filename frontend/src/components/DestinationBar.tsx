import { Briefcase, MapPin, CalendarRange, CircleDot, ChevronRight } from 'lucide-react';
import { cn } from '../lib/cn';
import { InfoTip, Tooltip } from '../ui/Tooltip';
import { LABEL_MICRO } from '../utils/labelMicro';

// A deeply nested area/iteration path ("some area\sub area\sub sub
// area\Customer Requirements" -- real ADO depth, not a fixture
// exaggeration) reads worse end-truncated ("some area\sub area\su…", the
// one part a reviewer actually recognizes cut off) than showing just its
// leaf. Unconditional on depth, not on measured width -- deterministic and
// scannable beats "sometimes full, sometimes cut" depending on container
// size. The full value is still one (fast, custom) tooltip away below.
function leafOnly(value: string): string {
  const parts = value.split('\\');
  return parts.length > 1 ? `…\\${parts[parts.length - 1]}` : value;
}

// DESIGN.md §11.2.2 -- "Destination as a breadcrumb, not a field stack."
// The prototype's `.destbar` -- a bordered, icon-led "Importing into
// [project] › [area path]" strip -- previously had no live equivalent;
// JobDetail rendered destination as a bare text line with no visual weight,
// easy to miss on a page a user may glance at for 30+ minutes during a
// SURVEY run. Shared here so both the New Job wizard (confirming where a
// submission is about to go) and JobDetail (confirming where it already
// went/is going) render it identically -- a second, wizard-only path bar
// would put the two screens' destination rendering on independent drift
// paths, which is the exact failure this shared component exists to
// prevent (this file's own original header comment).
//
// Redesign (requested explicitly, not a bug fix): the first version was 4
// visually-identical labeled boxes in a row -- Project, Area, and Iteration
// read as three unrelated facts even though they are literally one ADO
// path ("Project\Area\Sub"), and State (a workflow status, not a location)
// got no visual distinction from the location it happened to sit next to.
// Now Project/Area/Iteration render as one continuous mono-font path,
// joined by real chevrons -- the connector encodes the actual ADO
// hierarchy, not decoration -- and State sits behind a hairline divider as
// a small filled chip, reading as a stamp on the route rather than a
// fourth stop along it.
function PathSegment({
  icon: Icon,
  label,
  value,
  hatchWhenUnset,
}: {
  icon: typeof Briefcase;
  label: string;
  value: string | null | undefined;
  // DESIGN.md §11.2.2 -- an OPTIONAL segment (iteration path) renders a
  // repeating-gradient fill instead of going blank when unset, so an
  // optional gap reads as "not set," not as a missing/broken answer.
  hatchWhenUnset?: boolean;
}): React.ReactElement {
  const isUnset = !value;
  return (
    // No max-w here -- confirmed live: a fixed cap truncated the leaf
    // display even with most of the card sitting empty ("so much unused
    // space"). Default flex sizing (grow:0, shrink:1, basis:auto) already
    // gives the right behavior on its own: a segment renders at its full
    // natural width when the row has room, and only min-w-0 + the value
    // span's own `truncate` engage once the row's combined content
    // actually exceeds the available width -- shrinking, or wrapping
    // (flex-wrap on the row below) if even a single segment alone is
    // wider than the whole row on a narrow viewport. flex-none here (as
    // this used to be) disables shrinking outright regardless of space,
    // which is the opposite of that -- confirmed live as the original
    // overflow bug this class of fix keeps circling back to.
    <span className="hoverable-row flex min-w-0 items-center gap-1.5 rounded-sm px-1.5 py-1">
      <Icon className="h-3.5 w-3.5 flex-none text-ink-3" />
      <span className={cn('flex-none', LABEL_MICRO)}>{label}</span>
      {isUnset && hatchWhenUnset ? (
        <span
          className="h-3.5 w-12 flex-none rounded-sm border border-accent-soft-border"
          style={{
            backgroundImage: 'repeating-linear-gradient(45deg, var(--color-accent-soft) 0 4px, transparent 4px 8px)',
          }}
          aria-label={`${label} not set`}
        />
      ) : value ? (
        // Native `title` has a real, noticeable OS-level show delay
        // (confirmed live, reported as "taking too much time to load") --
        // this app's own Tooltip is a Radix primitive tuned to 200ms
        // (Tooltip.tsx), so swapping to it is a strict improvement, not a
        // tradeoff.
        <Tooltip content={value}>
          <span className="min-w-0 flex-1 truncate font-mono text-sm text-ink-1">{leafOnly(value)}</span>
        </Tooltip>
      ) : (
        <span className="min-w-0 flex-1 truncate font-mono text-sm text-ink-1">—</span>
      )}
    </span>
  );
}

// Real bug fixed here (confirmed live): ADO area/iteration paths are always
// project-prefixed ("Project\Area\Sub…"), so joining teamProject + areaPath
// + iterationPath naively repeated the project name up to 3 times in the
// same line ("elisradevops-project \ elisradevops-project\Customer
// Requirements \ elisradevops-project\Iteration 0") -- confirmed live,
// reported as "looking very bad." Exported (not inlined) so every consumer
// of the area/iteration display shares the identical, now-fixed dedup logic
// instead of each reimplementing its own join.
export function stripProjectPrefix(
  teamProject: string | null | undefined,
  path: string | null | undefined,
): string | null | undefined {
  if (!path || !teamProject) return path;
  // A project's own ROOT area/iteration has no "\Sub" suffix at all --
  // areaPath/iterationPath equals teamProject exactly, with no trailing
  // backslash for startsWith(prefix) to match. Real, common ADO state
  // (any project where no custom sub-area was ever created) -- without
  // this exact-equality check first, the root case fell straight through
  // unstripped and reprinted the project name a second time, reintroducing
  // the exact bug this function exists to fix.
  if (path === teamProject) return null;
  const prefix = `${teamProject}\\`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

export function formatDestinationPreview(
  teamProject: string | null | undefined,
  areaPath: string | null | undefined,
  iterationPath: string | null | undefined,
  state: string | null | undefined,
): string {
  const path = [teamProject, stripProjectPrefix(teamProject, areaPath), stripProjectPrefix(teamProject, iterationPath)]
    .filter(Boolean)
    .join(' \\ ');
  if (!state) return path;
  return path ? `${path} · state ${state}` : `state ${state}`;
}

export function DestinationBar({
  label = 'Destination',
  teamProject,
  areaPath,
  iterationPath,
  state,
}: {
  label?: string;
  teamProject?: string | null;
  areaPath?: string | null;
  // DESIGN.md §11.2.2 -- the two segments DestinationBar was missing before
  // this row: iteration path (optional, hatched when unset) and starting
  // state (not optional -- StatePicker/getStates always resolve one).
  iterationPath?: string | null;
  state?: string | null;
}): React.ReactElement | null {
  if (!teamProject && !areaPath) return null;
  // Same prefix strip formatDestinationPreview itself uses (still exported
  // below for NewJobWizard's own, genuinely non-redundant use -- its step-2
  // card has no boxed segments, only 4 editable form fields, so ONE mono
  // "read it back" line there is the sole restatement, not a second one).
  // Falls back to the raw value on strip's `null` (the area/iteration IS
  // the project's own root, a real, valid destination, not "unset" -- an
  // empty Area segment would misreport a deliberate choice as a missing
  // one), and only when the field itself has a value to begin with --
  // iteration's hatch-when-unset must still key off "was iterationPath
  // given at all," not "did stripping happen to leave nothing."
  const areaDisplay = areaPath == null ? areaPath : stripProjectPrefix(teamProject, areaPath) ?? areaPath;
  const iterationDisplay = iterationPath == null ? iterationPath : stripProjectPrefix(teamProject, iterationPath) ?? iterationPath;
  return (
    <div className="flex flex-col gap-1.5 rounded-sm border border-hairline-strong bg-surface-alt px-3 py-2 text-sm">
      <div className="flex items-center gap-1">
        <span className={LABEL_MICRO}>{label}</span>
        <InfoTip content="Where Confirm writes new work items. Existing items are only matched for reuse inside this exact area path." />
      </div>
      <div className="flex flex-wrap items-center gap-0.5">
        <PathSegment icon={Briefcase} label="Project" value={teamProject} />
        <ChevronRight className="h-3 w-3 flex-none text-accent" aria-hidden="true" />
        <PathSegment icon={MapPin} label="Area" value={areaDisplay} />
        <ChevronRight className="h-3 w-3 flex-none text-accent" aria-hidden="true" />
        <PathSegment icon={CalendarRange} label="Iteration" value={iterationDisplay} hatchWhenUnset />
        {/* State is a workflow status, not a location -- set apart behind a
            divider and rendered as a filled chip (not another path
            segment) so it reads as a stamp on the route, never a fourth
            stop along it. */}
        <span className="mx-1 h-4 w-px flex-none bg-hairline-strong" aria-hidden="true" />
        <span
          className={cn(
            'inline-flex flex-none items-center gap-1 rounded-full border border-accent-soft-border bg-accent-soft px-2 py-0.5',
            !state && 'border-hairline-strong bg-transparent',
          )}
          aria-label={`State: ${state || 'not set'}`}
        >
          <CircleDot className="h-3 w-3 flex-none text-accent-ink" />
          <span className="text-xs font-semibold text-accent-ink">{state || '—'}</span>
        </span>
      </div>
    </div>
  );
}
