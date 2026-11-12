import { RubricPanel } from './RubricPanel';
import { Dialog } from '../ui/Dialog';

// The grading rubric, opened from where it matters (the ingestion report, the knowledge-base health summary, a job's score
// explanation) instead of sitting open on the Knowledge Base page. The panel is unchanged; it reads the rubric when this opens.

export function RubricDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }): React.ReactElement {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      maxWidthClassName="max-w-[760px]"
      maxHeightClassName="max-h-[calc(100dvh-2rem)]"
      title="Grading rubric"
      description="What your jobs are graded against. A category you pin, edit or add stays exactly as you set it when your knowledge base changes."
    >
      <RubricPanel />
    </Dialog>
  );
}
