import { useEffect, useState } from 'react';
import { ChevronUp, ChevronDown } from 'lucide-react';
import { Dialog } from '../ui/Dialog';
import { Tabs } from '../ui/Tabs';
import { WorkItemTypeBadge } from './WorkItemTypeBadge';
import { ActionBadge } from './ActionBadge';
import { NodeDetailPanel, canEditEntry } from './NodeDetailPanel';
import { AddChildCard } from './AddChildCard';
import { ChatPanel } from './ChatPanel';
import type { DryRunDiffEntry } from './DiffTree';
import type { KbCitation } from './KbCitationChips';
import type { WorkItemTypeCatalogEntry } from '../api/ado';

// Matches the `lg` breakpoint the layout below switches on -- Tailwind's
// default `lg` is 1024px. Kept as a real matchMedia query (not CSS-only
// visibility) so only ONE of the two layout variants actually MOUNTS
// ChatPanel at a time -- see useIsAboveBreakpoint's own doc comment for why
// this matters.
const LG_BREAKPOINT_QUERY = '(min-width: 1024px)';

// Real conditional mounting, not just CSS display:none/block -- ChatPanel
// fetches history and opens a websocket connection unconditionally on
// mount (see ChatPanel.tsx's own useEffect/useChatSocket calls, keyed only
// on jobId/localId, not visibility). Rendering both the mobile-tabs layout
// and the desktop two-pane layout in the DOM simultaneously (gated only by
// `lg:hidden`/`hidden lg:flex` CSS classes, as an earlier version of this
// file did) mounted TWO separate ChatPanel instances for the same
// jobId+localId -- two history fetches, two open sockets, and two
// independently-diverging histories if the viewport crossed the lg
// breakpoint while the dialog was open. Returns null on the server/during
// the first client render (no window) so this never mismatches during
// hydration-less CSR; the effect below corrects it to the real value on
// mount.
function useIsAboveBreakpoint(query: string): boolean {
  const [matches, setMatches] = useState(() => (typeof window === 'undefined' ? false : window.matchMedia(query).matches));

  useEffect(() => {
    const mql = window.matchMedia(query);
    setMatches(mql.matches);
    const listener = (event: MediaQueryListEvent): void => setMatches(event.matches);
    mql.addEventListener('change', listener);
    return () => mql.removeEventListener('change', listener);
  }, [query]);

  return matches;
}

// Dedicated takeover dialog (not a centered form-sized modal, see
// ui/Dialog.tsx's unpadded/maxHeightClassName escape hatch) replacing the
// old cramped single-column sidebar: item details on the left, chat on the
// right, a collapsed-by-default "Add child item" card at the bottom of the
// left pane. Below `lg`, the two-pane layout doesn't have room for chat --
// collapses to Details/Chat tabs instead of squeezing a chat pane into a
// too-narrow column. The dialog stays open and swaps its content when a
// different row is selected (driven by the caller re-passing a new `entry`
// with the same `open=true`) -- prev/next chevrons in the header step
// through the same filtered row list the caller's arrow-key navigation
// already uses.
export function NodeDetailDialog({
  open,
  onOpenChange,
  jobId,
  entry,
  jobMode,
  jobStatus,
  kbCitations,
  traceTargetTitles,
  diffByLocalId,
  descendantCountsByLocalId,
  onSave,
  onRescore,
  onAddChild,
  onNavigate,
  hasPrev,
  hasNext,
  typeCatalog,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  jobId: string;
  entry: DryRunDiffEntry | null;
  jobMode?: 'baseline' | 'survey' | null;
  jobStatus?: string | null;
  kbCitations?: KbCitation[];
  traceTargetTitles?: Record<string, string>;
  diffByLocalId?: Record<string, DryRunDiffEntry>;
  // DESIGN.md §11.4.1 -- an Epic/Feature's Scope group needs real
  // descendant counts from the WHOLE diff tree; computed once by the
  // caller (JobDetail.tsx), resolved per-entry here same as diffByLocalId.
  descendantCountsByLocalId?: Record<string, { features: number; requirements: number }>;
  onSave?: (localId: string, patch: { title: string; description: string }) => void;
  onRescore?: (localId: string) => Promise<void>;
  onAddChild: (parentLocalId: string, input: { type: string; title: string; description: string }) => void;
  onNavigate?: (direction: 'prev' | 'next') => void;
  hasPrev?: boolean;
  hasNext?: boolean;
  typeCatalog?: Record<string, WorkItemTypeCatalogEntry>;
}): React.ReactElement | null {
  const [mobileTab, setMobileTab] = useState<'details' | 'chat'>('details');
  const isDesktop = useIsAboveBreakpoint(LG_BREAKPOINT_QUERY);

  // Reset to the details tab whenever the selected node changes -- staying
  // on a previous node's chat tab while looking at a new node's details
  // (or vice versa) would be confusing.
  useEffect(() => {
    setMobileTab('details');
  }, [entry?.localId]);

  if (!entry) return null;

  const canEdit = canEditEntry(entry, jobStatus);
  const chatDisabledReason =
    jobStatus != null && jobStatus !== 'diff_ready'
      ? "This job's review is closed -- chat is only available while it's awaiting review."
      : undefined;

  const addChildSlot =
    jobMode && jobStatus === 'diff_ready' ? (
      <AddChildCard parentEntry={entry} jobMode={jobMode} onAdd={(input) => onAddChild(entry.localId, input)} />
    ) : undefined;

  const detailsContent = (
    <NodeDetailPanel
      entry={entry}
      jobMode={jobMode}
      jobStatus={jobStatus}
      kbCitations={kbCitations}
      traceTargetTitles={traceTargetTitles}
      parentEntry={entry.parentLocalId != null ? diffByLocalId?.[entry.parentLocalId] : undefined}
      addChildSlot={addChildSlot}
      onSave={onSave}
      onRescore={onRescore}
      descendantCounts={descendantCountsByLocalId?.[entry.localId]}
    />
  );

  const chatContent = (
    <ChatPanel
      jobId={jobId}
      localId={entry.localId}
      disabled={!canEdit}
      disabledReason={chatDisabledReason}
      onAcceptProposal={(patch) =>
        onSave?.(entry.localId, {
          title: patch.title ?? entry.title,
          description: patch.description ?? entry.description,
        })
      }
    />
  );

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      unpadded
      maxWidthClassName="max-w-[1180px]"
      maxHeightClassName="h-[min(760px,calc(100vh-96px))]"
      title={
        <div className="flex min-w-0 items-center gap-2">
          {onNavigate && (
            <span className="flex flex-none flex-col">
              <button
                type="button"
                aria-label="Previous item"
                disabled={!hasPrev}
                onClick={() => onNavigate('prev')}
                className="text-ink-3 hover:text-ink-1 disabled:opacity-30"
              >
                <ChevronUp className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                aria-label="Next item"
                disabled={!hasNext}
                onClick={() => onNavigate('next')}
                className="text-ink-3 hover:text-ink-1 disabled:opacity-30"
              >
                <ChevronDown className="h-3.5 w-3.5" />
              </button>
            </span>
          )}
          <WorkItemTypeBadge type={entry.type} catalogEntry={typeCatalog?.[entry.type]} />
          <span className="truncate">{entry.title}</span>
          {entry.customerId && <span className="flex-none font-mono text-xs tracking-tight text-ink-3">{entry.customerId}</span>}
          <ActionBadge action={entry.action} existingAdoId={entry.existingAdoId} />
        </div>
      }
      /* Excluded is the only thing that still needs its own row -- everything
         else now sits inline next to the title (see `title` above), closing
         the wasted full-width row a lone "New" badge used to sit alone in. */
      description={
        entry.excluded ? <span className="text-xs text-ink-3">Excluded from this run</span> : undefined
      }
    >
      {isDesktop ? (
        // `lg` and up: real two-pane layout, details left / chat right.
        <div className="flex min-h-0 flex-1">
          <div className="min-h-0 flex-1 overflow-y-auto">{detailsContent}</div>
          <div className="min-h-0 w-[400px] flex-none border-l border-hairline">{chatContent}</div>
        </div>
      ) : (
        // Below `lg`: Details/Chat tabs instead of a too-narrow chat pane.
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex-none px-5">
            <Tabs
              value={mobileTab}
              onValueChange={(v) => setMobileTab(v as 'details' | 'chat')}
              tabs={[
                { value: 'details', label: 'Details' },
                { value: 'chat', label: 'Chat' },
              ]}
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">{mobileTab === 'details' ? detailsContent : chatContent}</div>
        </div>
      )}
    </Dialog>
  );
}
