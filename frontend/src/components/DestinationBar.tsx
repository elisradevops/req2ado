import { Briefcase } from 'lucide-react';
import { InfoTip } from '../ui/Tooltip';

// The prototype's `.destbar` -- a bordered, icon-led "Importing into
// [project] › [area path]" strip -- previously had no live equivalent;
// JobDetail rendered destination as a bare text line with no visual weight,
// easy to miss on a page a user may glance at for 30+ minutes during a
// SURVEY run. Shared here so both the New Job wizard (confirming where a
// submission is about to go) and JobDetail (confirming where it already
// went/is going) render it identically.
export function DestinationBar({
  label = 'Destination',
  teamProject,
  areaPath,
}: {
  label?: string;
  teamProject?: string | null;
  areaPath?: string | null;
}): React.ReactElement | null {
  if (!teamProject && !areaPath) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-sm border border-hairline-strong bg-surface-alt px-3 py-2 text-sm">
      <Briefcase className="h-4 w-4 flex-none text-accent" />
      <span className="text-micro font-semibold uppercase tracking-wide text-ink-3">{label}</span>
      {teamProject && <span className="font-medium text-ink-1">{teamProject}</span>}
      {areaPath && areaPath !== teamProject && (
        <>
          <span className="text-ink-3">›</span>
          <span className="font-mono text-xs text-ink-2">{areaPath}</span>
        </>
      )}
      <InfoTip content="Where Confirm writes new work items. Existing items are only matched for reuse inside this exact area path." />
    </div>
  );
}
