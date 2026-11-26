import { WorkItemTypeBadge } from './WorkItemTypeBadge';
import type { DryRunDiffEntry } from './DiffTree';
import { Button } from '../ui/Button';
import type { ReadingDecision } from '../api/jobs';
import { isExcludedWithAncestors } from '../utils/reviewQueue';

// An Epic's or Feature's own sections in the item dialog (the approved mockup, 2026-11-25): "Its decision" (what the new-job page proposed for
// the heading it was built from) and "Under it" (the items directly under it, with what will be written).

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The proposal for the heading an item was built from: the document grammar names such an item "g_" + the heading's block id. */
export function decisionFor(entry: DryRunDiffEntry, decisions: ReadingDecision[] | undefined): ReadingDecision | undefined {
  return decisions?.find((d) => `g_${d.headingId}` === entry.localId);
}

interface DecisionProps {
  entry: DryRunDiffEntry;
  decision: ReadingDecision;
  /** Whether the title can still change (not written, not reused); a rename's Accept/Keep is then a title edit. */
  editable: boolean;
  onRename?: (title: string) => void;
}

/**
 * A rename switches until the write: Accept sets the proposed title, Keep the file's (owner decision, 2026-11-26). A removed level is fixed for
 * the job: once accepted the level is not in the tree, so a kept one says how to change it instead of offering a switch that could not undo.
 */
export function ItsDecision({ entry, decision, editable, onRename }: DecisionProps): React.ReactElement {
  const rename = decision.action === 'rename' && decision.newTitle;
  const accepted = rename ? entry.title === decision.newTitle : decision.decision === 'accept';
  return (
    <section className="flex flex-col gap-1.5" aria-labelledby={`decision-${entry.localId}`} data-testid="its-decision">
      <h3 id={`decision-${entry.localId}`} className="text-xs font-semibold text-ink-1">
        Its decision
      </h3>
      <p className="text-sm text-ink-2" dir="auto">
        {rename ? `Proposed: rename “${decision.title}” to “${decision.newTitle}”.` : 'Proposed: remove this level and move what is under it up.'}{' '}
        <span className="text-ink-3">{decision.reason}</span>
      </p>
      {rename && editable && onRename ? (
        <div role="group" aria-label={`Decision for ${decision.title}`} className="flex">
          {(['accept', 'keep'] as const).map((choice) => {
            const chosen = choice === 'accept' ? accepted : !accepted;
            return (
              <Button
                key={choice}
                size="sm"
                variant={chosen ? 'primary' : 'outline'}
                aria-pressed={chosen}
                className={choice === 'accept' ? 'rounded-r-none' : '-ml-px rounded-l-none'}
                onClick={() => !chosen && onRename(choice === 'accept' ? decision.newTitle! : decision.title)}
              >
                {choice === 'accept' ? 'Accept' : 'Keep'}
              </Button>
            );
          })}
        </div>
      ) : (
        <p className="text-xs text-ink-3">
          {accepted ? 'Accepted.' : 'Kept as the file has it.'}
          {!rename && ' To change it, start a new job from this file.'}
        </p>
      )}
    </section>
  );
}

interface UnderItProps {
  entry: DryRunDiffEntry;
  entries: DryRunDiffEntry[];
  onOpen?: (localId: string) => void;
}

/** The items directly under an Epic or Feature, each with its requirement count, and what of it will be written (left-out items excluded). */
export function UnderIt({ entry, entries, onOpen }: UnderItProps): React.ReactElement {
  const byId = new Map(entries.map((e) => [e.localId, e]));
  const cache = new Map<string, boolean>();
  const leftOut = (e: DryRunDiffEntry): boolean => isExcludedWithAncestors(e, byId, cache);
  const childrenOf = new Map<string, DryRunDiffEntry[]>();
  for (const e of entries) if (e.parentLocalId) childrenOf.set(e.parentLocalId, [...(childrenOf.get(e.parentLocalId) ?? []), e]);
  const requirementsUnder = (localId: string, written: boolean): number =>
    (childrenOf.get(localId) ?? []).reduce(
      (sum, child) => sum + (child.type === 'Requirement' && (!written || !leftOut(child)) ? 1 : 0) + requirementsUnder(child.localId, written),
      0,
    );
  const children = childrenOf.get(entry.localId) ?? [];
  if (children.length === 0) return <p className="text-sm text-ink-2">Nothing is under this {entry.type} yet.</p>;
  const kept = children.filter((child) => !leftOut(child));
  const byType = (['Epic', 'Feature', 'Requirement'] as const)
    .map((type) => [type, kept.filter((child) => child.type === type).length] as const)
    .filter(([, n]) => n > 0);
  const written = requirementsUnder(entry.localId, true);
  const summary = [...byType.filter(([type]) => type !== 'Requirement').map(([type, n]) => plural(n, type)), plural(written, 'requirement')].join(' · ');
  return (
    <section className="flex flex-col gap-1.5" aria-labelledby={`under-${entry.localId}`} data-testid="under-it">
      <h3 id={`under-${entry.localId}`} className="text-xs font-semibold text-ink-1">
        Under it
      </h3>
      <p className="text-sm tabular-nums text-ink-2">{leftOut(entry) ? `${summary} · left out with this item` : `${summary} will be written`}</p>
      <ul className="flex flex-col">
        {children.map((child) => {
          const out = leftOut(child);
          const count = requirementsUnder(child.localId, false);
          return (
            <li key={child.localId}>
              <button
                type="button"
                className="hoverable-row flex min-h-8 w-full items-center gap-1.5 rounded-sm px-1.5 text-left text-sm"
                onClick={() => onOpen?.(child.localId)}
                disabled={!onOpen}
              >
                <WorkItemTypeBadge type={child.type} iconOnly />
                {child.customerId && <span className="flex-none font-mono text-xs text-ink-3">{child.customerId}</span>}
                <span dir="auto" className={`min-w-0 truncate ${out ? 'text-ink-3 line-through' : 'text-ink-1'}`}>
                  {child.title}
                </span>
                {out && <span className="flex-none text-xs text-ink-3">Left out</span>}
                {child.type !== 'Requirement' && <span className="ml-auto flex-none pl-2 font-mono text-xs text-ink-3">{count}</span>}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
