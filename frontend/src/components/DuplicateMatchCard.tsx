import { useState } from 'react';
import { ExternalLink, Layers, Undo2 } from 'lucide-react';
import { buildWorkItemUrl } from '../utils/adoLinks';
import { Alert } from '../ui/Alert';
import { Button } from '../ui/Button';
import { Checkbox } from '../ui/Checkbox';
import { Dialog } from '../ui/Dialog';
import { Spinner } from '../ui/Spinner';

// The review's answer to "this item already exists": which work item it matches and how alike they are, and the one thing the reviewer can do
// about it, which is to create it as a new item anyway. The existing item is never changed (editing it could lose the links and attachments it
// already has), so creating anyway makes a new one, optionally linked into this job's tree and optionally related to the existing one.

export interface DuplicateOverrideOptions {
  // Link the new item to its parent in this job's tree, and its children to it.
  linkTree: boolean;
  // Also add a Related link from the new item to the one it matched.
  relateToExisting: boolean;
}

interface EntryLike {
  action: 'create' | 'reuse' | 'dedup_skip';
  existingAdoId: number | null;
  similarity: number | null;
  duplicateOf?: { existingAdoId: number; similarity: number | null };
  duplicateOverride?: DuplicateOverrideOptions;
}

interface Props {
  entry: EntryLike;
  orgUrl: string | null | undefined;
  // The job's team project, for the link.
  project?: string | null;
  // The review is still open and the item has not been written.
  canDecide: boolean;
  onOverride: (options: DuplicateOverrideOptions) => Promise<void>;
  onUndo: () => Promise<void>;
}

const percent = (similarity: number | null): string | null => (similarity === null ? null : `${Math.round(similarity * 100)}% similar`);

function ExistingLink({ id, orgUrl, project }: { id: number; orgUrl: string | null | undefined; project?: string | null }): React.ReactElement {
  if (!orgUrl) return <span className="font-mono">work item {id}</span>;
  return (
    <a href={buildWorkItemUrl(orgUrl, project, id)} target="_blank" rel="noreferrer" aria-label={`Work item ${id}, opens in Azure DevOps`} className="inline-flex items-center gap-1 font-mono font-medium text-accent-ink underline underline-offset-2">
      WI-{id}
      <ExternalLink className="h-3 w-3" aria-hidden="true" />
    </a>
  );
}

export function DuplicateMatchCard({ entry, orgUrl, project, canDecide, onOverride, onUndo }: Props): React.ReactElement | null {
  const [open, setOpen] = useState(false);
  const [linkTree, setLinkTree] = useState(true);
  const [relate, setRelate] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const overridden = entry.duplicateOf !== undefined;
  const skipped = entry.action === 'dedup_skip' && entry.existingAdoId !== null;
  if (!overridden && !skipped) return null;

  const matchId = overridden ? entry.duplicateOf!.existingAdoId : entry.existingAdoId!;
  const alike = percent(overridden ? entry.duplicateOf!.similarity : entry.similarity);

  async function confirm(): Promise<void> {
    if (working) return;
    setWorking(true);
    setError(null);
    try {
      await onOverride({ linkTree, relateToExisting: relate });
      setOpen(false);
    } catch {
      setError('Could not create it as a new item. Try again.');
    } finally {
      setWorking(false);
    }
  }

  async function undo(): Promise<void> {
    if (working) return;
    setWorking(true);
    try {
      await onUndo();
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-hairline-strong bg-surface-alt p-3 text-sm">
      <p className="flex items-center gap-2 font-semibold text-ink-1">
        <Layers className="h-4 w-4 flex-none text-ink-2" aria-hidden="true" />
        {overridden ? 'Will be created as a new item' : 'Already exists in Azure DevOps'}
      </p>
      <p className="text-ink-2">
        {overridden ? 'It matched ' : 'This matches '}
        <ExistingLink id={matchId} orgUrl={orgUrl} project={project} />
        {alike ? ` (${alike})` : ''}.
        {overridden ? ' The existing item is not changed.' : ' It will not be created, and the existing item is not changed.'}
      </p>

      {overridden && entry.duplicateOverride && (
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-3">
          <li>{entry.duplicateOverride.linkTree ? "Linked into this job's tree" : "Not linked into this job's tree"}</li>
          {entry.duplicateOverride.relateToExisting && <li>Related to work item {matchId}</li>}
        </ul>
      )}

      {canDecide && (
        <div>
          {overridden ? (
            <Button size="sm" variant="outline" onClick={() => void undo()} disabled={working}>
              {working ? <Spinner /> : <Undo2 className="h-3.5 w-3.5" aria-hidden="true" />}
              Undo
            </Button>
          ) : (
            <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
              Create as new item…
            </Button>
          )}
        </div>
      )}

      <Dialog
        open={open}
        onOpenChange={(next) => !working && setOpen(next)}
        maxWidthClassName="max-w-[480px]"
        title="Create as a new item?"
        description={`A new work item is created with this content. The existing item ${matchId} is not changed, so its links and attachments stay as they are.`}
        footer={
          <>
            <span className="ml-auto" />
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={working}>
              Cancel
            </Button>
            <Button onClick={() => void confirm()} disabled={working}>
              {working && <Spinner />}
              Create as new item
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <label className="flex cursor-pointer items-start gap-2.5 text-sm text-ink-1">
            <Checkbox checked={linkTree} onCheckedChange={setLinkTree} ariaLabel="Link it into this job's tree" disabled={working} className="mt-0.5" />
            <span>
              Link it into this job's tree
              <span className="block text-xs text-ink-3">To its parent, and its children to it. Turn off to create it on its own.</span>
            </span>
          </label>
          <label className="flex cursor-pointer items-start gap-2.5 text-sm text-ink-1">
            <Checkbox checked={relate} onCheckedChange={setRelate} ariaLabel={`Also link it to work item ${matchId} as Related`} disabled={working} className="mt-0.5" />
            <span>
              Also link it to work item {matchId} as Related
              <span className="block text-xs text-ink-3">A Related link on the new item, so the two can be found from each other.</span>
            </span>
          </label>
          {error && <Alert severity="error">{error}</Alert>}
        </div>
      </Dialog>
    </div>
  );
}
