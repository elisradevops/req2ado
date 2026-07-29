import { useEffect, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { Button } from '../ui/Button';
import { AddChildForm } from './AddChildForm';
import type { DryRunDiffEntry } from './DiffTree';

// Collapsed-by-default disclosure wrapper around AddChildForm -- adding a
// child is an occasional, optional action, not a peer of the item's own
// details, so it collapses to a labeled trigger rather than the full form
// competing with the item's own content for attention. A bare icon square
// (an earlier version of this trigger) read as unlabeled/ambiguous -- a real
// button with its own text says exactly what it does, matching Edit's own
// visual weight next to it. AddChildForm itself is untouched (still a real
// component with its own tests) -- this only controls whether it's mounted.
export function AddChildCard({
  parentEntry,
  jobMode,
  onAdd,
}: {
  parentEntry: DryRunDiffEntry;
  jobMode: 'baseline' | 'survey';
  onAdd: (input: { type: string; title: string; description: string }) => void;
}): React.ReactElement | null {
  const [expanded, setExpanded] = useState(false);

  // Reset to collapsed whenever the selected node changes -- an expanded
  // add-child form for the PREVIOUS node showing (or worse, silently
  // retaining a stale draft) against the newly-selected one would be
  // confusing, same reasoning as NodeDetailPanel's own edit-mode reset.
  useEffect(() => {
    setExpanded(false);
  }, [parentEntry.localId]);

  if (parentEntry.isManual) return null;

  return (
    <div>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setExpanded((prev) => !prev)}
        aria-expanded={expanded}
        className="w-full justify-center"
      >
        {expanded ? (
          <>
            <X className="h-3.5 w-3.5" />
            Cancel
          </>
        ) : (
          <>
            <Plus className="h-3.5 w-3.5" />
            Add direct child WI
          </>
        )}
      </Button>
      {expanded && (
        // Dashed border + canvas tint (vs. the solid white surface the
        // read-only details above use) reads as "draft -- not a real item
        // yet", distinguishing it from the item's own existing content.
        <div className="mt-2.5 overflow-hidden rounded-md border border-dashed border-hairline-strong bg-canvas">
          <AddChildForm
            parentEntry={parentEntry}
            jobMode={jobMode}
            onAdd={(input) => {
              onAdd(input);
              setExpanded(false);
            }}
          />
        </div>
      )}
    </div>
  );
}
