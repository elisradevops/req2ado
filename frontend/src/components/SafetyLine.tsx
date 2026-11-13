import { Lock } from 'lucide-react';

// DESIGN.md §0, item 3: no visual state may be ambiguous between "proposed" and "written". Every screen restates it.
// One source for the words, so a screen can never drift to its own wording.
export const WIZARD_SAFETY_TEXT = 'Nothing reaches Azure DevOps until you approve the proposed diff.';
export const RUNNING_SAFETY_TEXT = 'Nothing has been written to Azure DevOps. Writing only starts after you approve the diff.';

// Quiet by design: ink-3 text and a lock glyph. Never the signal colour, which belongs to the irreversible write alone (§16.7).
export function SafetyLine({ variant }: { variant: 'wizard' | 'running' }): React.ReactElement {
  return (
    <span className="flex items-center gap-1.5 text-xs text-ink-3">
      <Lock className="h-3.5 w-3.5 flex-none" aria-hidden="true" />
      {variant === 'wizard' ? WIZARD_SAFETY_TEXT : RUNNING_SAFETY_TEXT}
    </span>
  );
}
