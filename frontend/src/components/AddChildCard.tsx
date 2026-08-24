import { useEffect, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { Button } from '../ui/Button';
import { AddChildForm } from './AddChildForm';
import type { DryRunDiffEntry } from './DiffTree';
import type { WorkItemTypeCatalogEntry } from '../api/ado';

// Collapsed-by-default disclosure wrapper around AddChildForm -- adding a
// child is an occasional, optional action, not a peer of the item's own
// details, so it collapses to a labeled trigger rather than the full form
// competing with the item's own content for attention. A bare icon square
// (an earlier version of this trigger) read as unlabeled/ambiguous -- a real
// button with its own text says exactly what it does, matching Edit's own
// visual weight next to it. AddChildForm itself is untouched (still a real
// component with its own tests) -- this only controls whether it's mounted.
//
// parentEntry is OPTIONAL -- this same card backs two call sites: "Add
// child" from NodeDetailDialog (a real anchor entry) and the diff tree's
// own toolbar "+ New item" (JobDetail.tsx, no anchor at all -- see
// AddChildForm.tsx's top comment for why BASELINE mode is anchor-only).
export function AddChildCard({
  parentEntry,
  jobMode,
  allEntries,
  categoryLabels,
  typeCatalog,
  onAdd,
}: {
  parentEntry?: DryRunDiffEntry;
  jobMode: 'baseline' | 'survey';
  allEntries: DryRunDiffEntry[];
  categoryLabels?: Record<'Epic' | 'Feature' | 'Requirement', string>;
  typeCatalog?: Record<string, WorkItemTypeCatalogEntry>;
  onAdd: (input: { parentLocalId: string | null; type: string; title: string; description: string }) => void;
}): React.ReactElement | null {
  const [expanded, setExpanded] = useState(false);

  // Reset to collapsed whenever the selected node changes -- an expanded
  // add-child form for the PREVIOUS node showing (or worse, silently
  // retaining a stale draft) against the newly-selected one would be
  // confusing, same reasoning as NodeDetailPanel's own edit-mode reset.
  // No-op for the toolbar call site (parentEntry undefined -> the
  // dependency never changes).
  useEffect(() => {
    setExpanded(false);
  }, [parentEntry?.localId]);

  // CR: reparent -- BASELINE mode still can't add a child under a manual
  // parent (its childType is always null, so no real type could ever
  // match -- see jobs.service.ts's addDiffEntry doc comment); SURVEY mode
  // now can, since the parent is freely changeable via AddChildForm's own
  // picker. See AddChildForm.tsx's top comment for the full rationale.
  if (parentEntry?.isManual && jobMode === 'baseline') return null;

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
            {parentEntry ? 'Add direct child WI' : 'New item'}
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
            allEntries={allEntries}
            categoryLabels={categoryLabels}
            typeCatalog={typeCatalog}
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
