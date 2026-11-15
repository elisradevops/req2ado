import { Ban, CircleCheck, CircleX, Clock, Minus, TriangleAlert, type LucideIcon } from 'lucide-react';
import type { KbIngestBatch, KbIngestItem, KbIngestItemState, KbProfileDocument } from '../api/kb';
import type { KbProfileRead } from '../hooks/useKbProfile';
import { cn } from '../lib/cn';
import { Alert } from '../ui/Alert';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Spinner } from '../ui/Spinner';

// What a finished batch did: what happened to each file, and what each one gave the grading rubric (the rubric is built in the
// background some time after, so that half reads from the profile and may still be on its way). Everything is said in words with an
// icon, never by colour alone. It only shows what it is given: the batch and the profile are read elsewhere.

const OUTCOME: Record<KbIngestItemState, { word: string; Icon: LucideIcon; className: string }> = {
  queued: { word: 'Waiting', Icon: Clock, className: 'text-ink-3' },
  running: { word: 'Adding', Icon: Clock, className: 'text-ink-3' },
  added: { word: 'Added', Icon: CircleCheck, className: 'text-ok-ink' },
  unchanged: { word: 'Already up to date', Icon: CircleCheck, className: 'text-ink-3' },
  failed: { word: 'Failed', Icon: CircleX, className: 'text-danger-ink' },
  skipped: { word: 'Skipped', Icon: Minus, className: 'text-ink-3' },
  cancelled: { word: 'Cancelled', Icon: Ban, className: 'text-ink-3' },
};

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  batch: KbIngestBatch;
  // The grading rubric as last read, and whether it is still on its way.
  rubric: KbProfileRead;
  // Opens the rubric for editing.
  onCustomizeRubric: () => void;
}

function outcomeDetail(item: KbIngestItem): string | null {
  if (item.state === 'added' || item.state === 'unchanged') {
    if (item.chunksInStore === 0) return 'No text could be stored. The file may be scanned images or empty; try a text-based version.';
    return item.chunksInStore !== null ? `${item.chunksInStore} ${plural(item.chunksInStore, 'chunk', 'chunks')}` : null;
  }
  // A stored reason that only repeats the state word ("cancelled") adds nothing beside it.
  return item.reason && item.reason.toLowerCase() !== OUTCOME[item.state].word.toLowerCase() ? item.reason : null;
}

// What the rubric made of one file, said for a file that is in the knowledge base now.
function rubricNote(document: KbProfileDocument | undefined, shared: boolean, ready: boolean): string | null {
  if (shared) return 'Same name as another file in this batch, so the rubric’s entry cannot be told apart.';
  if (!ready) return null;
  if (!document) return 'Not in the rubric yet.';
  switch (document.status) {
    case 'contributed':
      return `Shaped the rubric: ${document.categories} ${plural(document.categories, 'category', 'categories')}, ${document.rules} ${plural(document.rules, 'rule', 'rules')}.`;
    case 'not_relevant':
      return `Not used by the rubric${document.reason ? `: ${document.reason}` : '.'}`;
    case 'extracted_nothing':
      return 'Nothing could be extracted from it for the rubric.';
    case 'failed':
      return `Could not be analysed for the rubric${document.reason ? `: ${document.reason}` : '.'}`;
    default:
      return null;
  }
}

function RubricStatus({ rubric }: { rubric: KbProfileRead }): React.ReactElement | null {
  const { status, profile } = rubric;
  if (status === 'idle') return null;
  if (status === 'loading' || status === 'waiting') {
    return (
      <p role="status" className="flex items-center gap-2 text-sm text-ink-2">
        <Spinner className="h-3.5 w-3.5 text-live" />
        Updating the grading rubric with these files. This can take a few minutes.
      </p>
    );
  }
  if (status === 'timeout') return <Alert severity="warning">Still not updated after 10 minutes. It keeps going on its own; check back later.</Alert>;
  if (status === 'no_model') return <Alert severity="info">No model connection is set up to build the rubric with. Your first job builds it with its own.</Alert>;
  if (status === 'none') return <Alert severity="info">No rubric yet. It is built once your knowledge base has documents.</Alert>;
  if (status === 'error') return <Alert severity="warning">Could not read the rubric status. Trying again.</Alert>;
  if (!profile) return null;
  return (
    <div className="flex flex-col gap-1 text-sm text-ink-2">
      <p>
        The rubric draws on {profile.docsContributing} of {profile.docsInKb} {plural(profile.docsInKb, 'document', 'documents')}.
      </p>
      {profile.conflicts.length > 0 && (
        <p>
          {profile.conflicts.length} {plural(profile.conflicts.length, 'disagreement', 'disagreements')} between documents {plural(profile.conflicts.length, 'was', 'were')} found; the rubric keeps the most common reading.
        </p>
      )}
      {profile.truncated && <p>Not every document fit in one read, so the rubric may leave some out.</p>}
    </div>
  );
}

export function KbIngestReport({ open, onOpenChange, batch, rubric, onCustomizeRubric }: Props): React.ReactElement {
  const items = batch.items ?? [];
  const documents = new Map((rubric.profile?.docs ?? []).map((document) => [document.file, document]));
  const nameCounts = new Map<string, number>();
  for (const item of items) nameCounts.set(item.name, (nameCounts.get(item.name) ?? 0) + 1);
  const rubricReady = rubric.status === 'ready';

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      maxWidthClassName="max-w-[640px]"
      maxHeightClassName="max-h-[calc(100dvh-2rem)]"
      title="Ingestion report"
      description="What happened to each file, and what it gave the grading rubric."
      footer={
        <>
          {rubricReady && (
            <Button variant="outline" onClick={onCustomizeRubric}>
              Customize the rubric
            </Button>
          )}
          <span className="ml-auto" />
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        </>
      }
    >
      <RubricStatus rubric={rubric} />
      <ul aria-label="Files in this batch" className="flex max-h-80 flex-col divide-y divide-hairline overflow-y-auto rounded-sm border border-hairline">
        {items.map((item) => {
          const { word, Icon, className } = OUTCOME[item.state];
          const detail = outcomeDetail(item);
          const added = item.state === 'added' || item.state === 'unchanged';
          const note = added ? rubricNote(documents.get(item.name), (nameCounts.get(item.name) ?? 0) > 1, rubricReady) : null;
          const folder = item.relativePath.includes('/') ? item.relativePath.slice(0, item.relativePath.lastIndexOf('/')) : null;
          const warn = item.chunksInStore === 0;
          return (
            <li key={item.id} className="flex flex-col gap-0.5 px-2.5 py-2 text-sm">
              <span className="flex items-center gap-2">
                <Icon className={cn('h-4 w-4 flex-none', className)} aria-hidden="true" />
                <span className="min-w-0 font-medium text-ink-1 [overflow-wrap:anywhere]">
                  <bdi dir="auto">{item.name}</bdi>
                </span>
                {folder && (
                  <span className="min-w-0 text-xs text-ink-3 [overflow-wrap:anywhere]">
                    in <bdi dir="auto">{folder}</bdi>
                  </span>
                )}
              </span>
              <span className={cn('flex items-start gap-1.5 pl-6 text-xs', warn ? 'text-warning-ink' : 'text-ink-3')}>
                {warn && <TriangleAlert className="mt-px h-3.5 w-3.5 flex-none" aria-hidden="true" />}
                <span>
                  {word}
                  {detail ? ` · ${detail}` : ''}
                </span>
              </span>
              {note && <span className="pl-6 text-xs text-ink-2">{note}</span>}
            </li>
          );
        })}
      </ul>
    </Dialog>
  );
}
