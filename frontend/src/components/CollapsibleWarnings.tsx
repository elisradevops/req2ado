import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { cn } from '../lib/cn';
import { buildWorkItemUrl } from '../utils/adoLinks';
import type { WarningRecord } from '../utils/warnings';
import {
  GROUP_META,
  GROUP_ORDER,
  SEVERITY_LABEL,
  buildKindGroups,
  kindGroupCount,
  kindProgress,
  retryableEnhancementBatches,
  type RetryablePass,
  type WarningGroup,
  type WarningKindGroup,
} from '../utils/warningKinds';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '../ui/Accordion';
import { Button } from '../ui/Button';
import { ProgressBar } from '../ui/ProgressBar';
import { AnimatedNumber } from '../ui/AnimatedNumber';
import { DoneChip } from '../ui/DoneChip';

const GROUP_HEAD_CLASS: Record<WarningGroup, string> = {
  fix: 'bg-danger-soft text-danger-ink',
  review: 'bg-warning-soft text-warning-ink',
  info: 'bg-surface-sunken text-ink-2',
};

// A kind with this many affected items or fewer lists them inside its
// details (so each can be opened, and linked to Azure DevOps when it already
// exists there). Larger sets are worked through in the tree instead -- a
// list of 275 buttons was the problem this panel was redesigned to remove.
const INLINE_ITEM_LIMIT = 5;
const RAW_PREVIEW_LIMIT = 3;
const REVIEW_LABEL_MAX_CHARS = 40;

function truncateForLabel(text: string): string {
  return text.length > REVIEW_LABEL_MAX_CHARS ? `${text.slice(0, REVIEW_LABEL_MAX_CHARS - 1)}…` : text;
}

function pluralize(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
}

// SURVEY's integrity warnings can run into the dozens (and one kind can
// cover hundreds of items). Grouped by what the reviewer has to DO about
// them -- fix / review / for your information -- with one compact row per
// kind. Affected items are worked through in the tree (onFocusKind filters
// it), not listed here; see DESIGN.md §11.3.3.
export function CollapsibleWarnings({
  warnings,
  onFocusKind,
  focusedKind,
  reviewedIds,
  onAcknowledge,
  onRetryEnhancement,
  onCancelRetry,
  retryProgress,
  onJumpToNode,
  adoIdByLocalId,
  titleByLocalId,
  orgUrl,
  project,
}: {
  warnings: WarningRecord[];
  // Filters the proposed tree to a kind's affected items. Omitted: rows
  // show no tree button.
  onFocusKind?: (kind: string, nodeIds: string[], label: string) => void;
  focusedKind?: string | null;
  // localIds the reviewer has marked reviewed -- drives each kind's
  // progress ("28 of 80 reviewed") and its Done state.
  reviewedIds?: ReadonlySet<string>;
  // Marks a kind's warnings handled -- all its records, or only those whose
  // raw text is in `raws`. Omitted (job no longer awaiting review): no
  // marking controls are shown, progress stays visible.
  onAcknowledge?: (kind: string, raws: string[] | undefined, acknowledged: boolean) => void;
  // Re-runs a failed enhancement pass for just the affected items. The
  // caller owns the batching and the loop. Omitted (job no longer awaiting
  // review): no Retry button.
  onRetryEnhancement?: (kind: string, batches: { pass: RetryablePass; localIds: string[] }[]) => void;
  onCancelRetry?: () => void;
  // Set while a retry is running: which kind, and how many of its items are done.
  retryProgress?: { kind: string; done: number; total: number } | null;
  // Opens one item's details dialog. Used for the small inline item list.
  onJumpToNode?: (localId: string) => void;
  // localId -> existing Azure DevOps id (dedup_skip/reuse entries only).
  // A warning's nodeIds are internal to THIS run and mean nothing outside
  // the app, so an item that already exists in ADO gets a real deep link.
  adoIdByLocalId?: Record<string, number>;
  titleByLocalId?: Record<string, string>;
  orgUrl?: string | null;
  project?: string | null;
}): React.ReactElement | null {
  const kindGroups = useMemo(() => buildKindGroups(warnings), [warnings]);
  const hasActionable = kindGroups.some((entry) => entry.group !== 'info');
  const [openKind, setOpenKind] = useState('');
  // For your information stays collapsed unless it's all there is.
  const [infoOpen, setInfoOpen] = useState(() => !hasActionable);

  if (kindGroups.length === 0) return null;

  const summary = GROUP_ORDER.map((group) => ({ group, count: kindGroups.filter((entry) => entry.group === group).length }))
    .filter(({ count }) => count > 0)
    .map(({ group, count }) =>
      group === 'fix' ? `${count} to fix` : group === 'review' ? `${count} to review` : `${count} for your information`,
    )
    .join(', ');

  return (
    <section aria-label="Integrity warnings" className="overflow-hidden rounded-sm border border-hairline bg-surface">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 border-b border-hairline px-3.5 py-2.5">
        <h2 className="text-sm font-semibold text-ink-1">Integrity warnings</h2>
        <span className="text-xs text-ink-3">{summary}</span>
      </div>
      <Accordion value={openKind} onValueChange={setOpenKind}>
        {GROUP_ORDER.map((group) => {
          const entries = kindGroups.filter((entry) => entry.group === group);
          if (entries.length === 0) return null;
          const { title, line } = GROUP_META[group];
          const collapsible = group === 'info';
          const open = !collapsible || infoOpen;
          return (
            <div key={group} className="border-b border-hairline last:border-b-0">
              {collapsible ? (
                <button
                  type="button"
                  onClick={() => setInfoOpen((prev) => !prev)}
                  aria-expanded={open}
                  className={cn('flex w-full flex-wrap items-center gap-x-2.5 gap-y-0.5 px-3.5 py-2 text-left text-xs', GROUP_HEAD_CLASS[group])}
                >
                  {open ? <ChevronDown className="h-3.5 w-3.5 flex-none" /> : <ChevronRight className="h-3.5 w-3.5 flex-none" />}
                  <span className="font-semibold">
                    {title} ({entries.length})
                  </span>
                  <span className="opacity-85">{line}</span>
                </button>
              ) : (
                <div className={cn('flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5 px-3.5 py-2 text-xs', GROUP_HEAD_CLASS[group])}>
                  <span className="font-semibold">
                    {title} ({entries.length})
                  </span>
                  <span className="opacity-85">{line}</span>
                </div>
              )}
              {open &&
                entries.map((entry) => (
                  <KindRow
                    key={entry.kind}
                    entry={entry}
                    focused={focusedKind === entry.kind}
                    reviewedIds={reviewedIds}
                    onAcknowledge={onAcknowledge}
                    onRetryEnhancement={onRetryEnhancement}
                    onCancelRetry={onCancelRetry}
                    retryProgress={retryProgress}
                    onFocusKind={onFocusKind}
                    onJumpToNode={onJumpToNode}
                    adoIdByLocalId={adoIdByLocalId}
                    titleByLocalId={titleByLocalId}
                    orgUrl={orgUrl}
                    project={project}
                  />
                ))}
            </div>
          );
        })}
      </Accordion>
    </section>
  );
}

function KindRow({
  entry,
  focused,
  reviewedIds,
  onAcknowledge,
  onRetryEnhancement,
  onCancelRetry,
  retryProgress,
  onFocusKind,
  onJumpToNode,
  adoIdByLocalId,
  titleByLocalId,
  orgUrl,
  project,
}: {
  entry: WarningKindGroup;
  focused: boolean;
  reviewedIds?: ReadonlySet<string>;
  onAcknowledge?: (kind: string, raws: string[] | undefined, acknowledged: boolean) => void;
  onRetryEnhancement?: (kind: string, batches: { pass: RetryablePass; localIds: string[] }[]) => void;
  onCancelRetry?: () => void;
  retryProgress?: { kind: string; done: number; total: number } | null;
  onFocusKind?: (kind: string, nodeIds: string[], label: string) => void;
  onJumpToNode?: (localId: string) => void;
  adoIdByLocalId?: Record<string, number>;
  titleByLocalId?: Record<string, string>;
  orgUrl?: string | null;
  project?: string | null;
}): React.ReactElement {
  const { meta } = entry;
  const { count, label } = kindGroupCount(entry);
  const canFocus = !!onFocusKind && entry.nodeIds.length > 0;
  const actionLabel = meta.actionLabel ?? GROUP_META[entry.group].actionLabel;
  const progress = kindProgress(entry, reviewedIds);
  const showProgress = progress.trackable && progress.total > 1 && !progress.complete;
  const retryBatches = onRetryEnhancement ? retryableEnhancementBatches(entry) : [];
  const retrying = retryProgress?.kind === entry.kind ? retryProgress : null;

  return (
    <AccordionItem value={entry.kind} className="hoverable-row grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 px-3.5 py-2.5 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
      <AccordionTrigger>
        <span className={cn('block font-semibold', progress.complete ? 'text-ink-3' : 'text-ink-1')}>
          {meta.title}
          {progress.complete && <DoneChip className="ml-2" />}
        </span>
        <span className="block text-xs text-ink-3">{meta.short}</span>
        {retrying && (
          <span className="mt-1.5 flex items-center gap-2 text-xs text-ink-3">
            <span className="w-20 flex-none">
              <ProgressBar value={(retrying.done / retrying.total) * 100} active />
            </span>
            <span className="tabular-nums" role="status">
              Retrying: <AnimatedNumber value={retrying.done} /> of {retrying.total.toLocaleString()}
            </span>
          </span>
        )}
        {showProgress && (
          <span className="mt-1.5 flex items-center gap-2 text-xs text-ink-3">
            <span className="w-20 flex-none">
              <ProgressBar value={(progress.reviewed / progress.total) * 100} />
            </span>
            <span className="tabular-nums">
              <AnimatedNumber value={progress.reviewed} /> of {progress.total.toLocaleString()} reviewed
            </span>
          </span>
        )}
      </AccordionTrigger>
      <span className="text-right text-xs tabular-nums text-ink-2">
        {count.toLocaleString()} {label}
      </span>
      {(canFocus || retryBatches.length > 0) && (
        <span className="col-span-2 flex flex-wrap items-center gap-2 justify-self-start sm:col-span-1 sm:justify-self-end">
          {retryBatches.length > 0 &&
            (retrying ? (
              <Button size="sm" variant="ghost" onClick={onCancelRetry}>
                Stop
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                disabled={!!retryProgress}
                onClick={() => onRetryEnhancement?.(entry.kind, retryBatches)}
              >
                Retry enhancement
              </Button>
            ))}
          {canFocus && (
            <Button
              size="sm"
              variant={entry.group === 'info' ? 'outline' : 'primary'}
              aria-pressed={focused}
              onClick={() => onFocusKind(entry.kind, entry.nodeIds, meta.title)}
            >
              {actionLabel}
            </Button>
          )}
        </span>
      )}
      {!canFocus && progress.trackable && onAcknowledge && (
        // No tree to work through: the reviewer just says it's handled.
        // Offered for a completed kind only to undo an acknowledgement that
        // was actually made (not one completed through item reviews).
        <>
          {!progress.complete && (
            <Button
              size="sm"
              variant="outline"
              className="col-span-2 justify-self-start sm:col-span-1"
              onClick={() => onAcknowledge(entry.kind, undefined, true)}
            >
              Mark handled
            </Button>
          )}
          {progress.complete && progress.allAcknowledged && (
            <Button
              size="sm"
              variant="ghost"
              className="col-span-2 justify-self-start sm:col-span-1"
              onClick={() => onAcknowledge(entry.kind, undefined, false)}
            >
              Undo
            </Button>
          )}
        </>
      )}
      <AccordionContent className="col-span-full">
        <KindDetails
          entry={entry}
          onAcknowledge={onAcknowledge}
          onJumpToNode={onJumpToNode}
          adoIdByLocalId={adoIdByLocalId}
          titleByLocalId={titleByLocalId}
          orgUrl={orgUrl}
          project={project}
        />
      </AccordionContent>
    </AccordionItem>
  );
}

function KindDetails({
  entry,
  onAcknowledge,
  onJumpToNode,
  adoIdByLocalId,
  titleByLocalId,
  orgUrl,
  project,
}: {
  entry: WarningKindGroup;
  onAcknowledge?: (kind: string, raws: string[] | undefined, acknowledged: boolean) => void;
  onJumpToNode?: (localId: string) => void;
  adoIdByLocalId?: Record<string, number>;
  titleByLocalId?: Record<string, string>;
  orgUrl?: string | null;
  project?: string | null;
}): React.ReactElement {
  const { meta, records, nodeIds, severities } = entry;
  // Per-record marking: only for a trackable kind that tracks its own
  // records (no tree items) and has more than one to tell apart.
  const canAckRecords = !!onAcknowledge && entry.group !== 'info' && nodeIds.length === 0 && records.length > 1;
  const [showAllRaw, setShowAllRaw] = useState(false);
  const shownRecords = showAllRaw ? records : records.slice(0, RAW_PREVIEW_LIMIT);
  const hiddenCount = records.length - shownRecords.length;
  const inlineItems = nodeIds.length > 0 && nodeIds.length <= INLINE_ITEM_LIMIT ? nodeIds : [];

  return (
    <div className="flex flex-col gap-3 pb-1 pl-5.5 pt-2 text-sm">
      <dl className="grid max-w-[74ch] grid-cols-1 gap-x-4 gap-y-0.5 sm:grid-cols-[110px_minmax(0,1fr)]">
        <dt className="text-xs leading-5 text-ink-3">What it means</dt>
        <dd className="mb-1.5 sm:mb-0">{meta.means}</dd>
        <dt className="text-xs leading-5 text-ink-3">What to do</dt>
        <dd className="mb-1.5 sm:mb-0">{meta.todo}</dd>
        <dt className="text-xs leading-5 text-ink-3">Reported as</dt>
        <dd>{severities.map((severity) => SEVERITY_LABEL[severity]).join(', ')}</dd>
      </dl>

      <ul className="flex max-w-[74ch] flex-col gap-1.5">
        {shownRecords.map((record, index) => (
          <li key={index} className="flex items-start gap-2 border-l-2 border-hairline pl-2.5 text-ink-2">
            <span className={cn('min-w-0 flex-1', record.acknowledged && 'text-ink-3 line-through decoration-hairline-strong')}>
              {record.raw}
              {record.legacy && <span className="ml-1.5 text-xs opacity-60">(from an older run)</span>}
            </span>
            {canAckRecords && (
              <Button
                size="sm"
                variant={record.acknowledged ? 'ghost' : 'outline'}
                className="flex-none"
                onClick={() => onAcknowledge(entry.kind, [record.raw], !record.acknowledged)}
              >
                {record.acknowledged ? 'Undo' : 'Fine as is'}
              </Button>
            )}
          </li>
        ))}
      </ul>
      {records.length > RAW_PREVIEW_LIMIT && (
        <button
          type="button"
          onClick={() => setShowAllRaw((prev) => !prev)}
          className="w-fit text-xs font-medium text-accent hover:underline"
        >
          {showAllRaw ? 'Show fewer' : `Show ${hiddenCount} more ${pluralize(hiddenCount, 'notice')}`}
        </button>
      )}

      {inlineItems.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {inlineItems.map((localId, index) => {
            const adoId = adoIdByLocalId?.[localId];
            const itemTitle = titleByLocalId?.[localId];
            return (
              <li key={localId} className="flex flex-wrap items-center gap-2">
                {onJumpToNode && (
                  <Button size="sm" variant="outline" onClick={() => onJumpToNode(localId)}>
                    Open {itemTitle ? `"${truncateForLabel(itemTitle)}"` : `item ${index + 1}`}
                  </Button>
                )}
                {adoId != null && orgUrl && (
                  <a
                    href={buildWorkItemUrl(orgUrl, project, adoId)}
                    target="_blank"
                    rel="noreferrer"
                    className="font-mono text-xs text-accent hover:underline"
                  >
                    View WI #{adoId} in Azure DevOps ↗
                  </a>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {entry.kind === 'external_reference' && (
        <Link
          to="/knowledge-base"
          className="w-fit rounded-sm border border-field-border bg-surface px-2.5 py-1 text-xs font-medium text-ink-1 hover:border-accent"
        >
          Add to knowledge base →
        </Link>
      )}
    </div>
  );
}
