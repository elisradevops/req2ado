import type { DryRunDiffEntry } from '../components/DiffTree';

// The figures that will be attached to an item automatically. The server decides this (`attachFigureIds`); the fallback below only
// serves responses and fixtures that predate that field: captioned figures plus uncaptioned ones the vision model did not mark
// insignificant, and only for an item the job creates.
export function attachFigureIdsOf(entry: DryRunDiffEntry): string[] {
  if (entry.attachFigureIds) return entry.attachFigureIds;
  if (entry.action !== 'create') return [];
  const insignificant = entry.insignificantFigureIds ?? [];
  const detached = entry.detachedFigureIds ?? [];
  return [...(entry.figureIds ?? []), ...(entry.uncaptionedFigureIds ?? []).filter((id) => !insignificant.includes(id))].filter(
    (id) => !detached.includes(id),
  );
}
