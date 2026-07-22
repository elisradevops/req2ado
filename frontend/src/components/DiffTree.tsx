import { useCallback, useEffect, useMemo, useRef } from 'react';
import { VariableSizeList } from 'react-window';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import Checkbox from '@mui/material/Checkbox';
import { ActionBadge } from './ActionBadge';
import { TagChips } from './TagChips';
import { TraceLinkChips } from './TraceLinkChips';

// Pre-measurement estimate only -- real row height is measured per-row (see
// MeasuredRow below) since wrapped title/chip height can't be reliably
// estimated (chip-wrap height depends on per-chip label width, chip count,
// and MUI gap/padding). Used for VariableSizeList's initial scrollbar
// geometry before any row has been measured.
const DEFAULT_ROW_HEIGHT = 56;

// Small measurement wrapper: reports its child's REAL rendered height via
// ResizeObserver, which fires on mount and on any subsequent size change
// (e.g. column width narrowing changes the title's wrap point). This is
// what lets react-window's fixed-height row slot (`style`) actually match
// variable wrapped content instead of clipping/overlapping it.
function MeasuredRow({
  index,
  onMeasure,
  children,
}: {
  index: number;
  onMeasure: (index: number, size: number) => void;
  children: React.ReactNode;
}): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const report = (): void => onMeasure(index, el.getBoundingClientRect().height);
    report();
    const observer = new ResizeObserver(report);
    observer.observe(el);
    return () => observer.disconnect();
  }, [index, onMeasure]);

  return <div ref={ref}>{children}</div>;
}

export interface DryRunDiffEntry {
  localId: string;
  parentLocalId: string | null;
  type: string;
  title: string;
  description: string;
  action: 'create' | 'reuse' | 'dedup_skip';
  existingAdoId?: number | null;
  customerId: string | null;
  tags?: string[];
  qualityScore?: number | null;
  qualityIssues?: string[];
  childType?: string | null;
  excluded?: boolean;
  isManual?: boolean;
  traceLinks?: {
    sourceLocalId: string;
    referenceName: string;
    displayName: string;
    targetKind: 'intraJob' | 'crossJob';
    targetLocalId?: string;
    targetCustomerId?: string;
    resolvedAdoId?: number;
    resolutionStatus: 'resolved' | 'unresolved' | 'pending';
  }[];
}

interface FlatRow {
  entry: DryRunDiffEntry;
  depth: number;
}

function buildFlatRows(entries: DryRunDiffEntry[]): FlatRow[] {
  const byParent = new Map<string | null, DryRunDiffEntry[]>();
  const idSet = new Set(entries.map((entry) => entry.localId));
  for (const entry of entries) {
    const parentKey = entry.parentLocalId && idSet.has(entry.parentLocalId) ? entry.parentLocalId : null;
    const siblings = byParent.get(parentKey) ?? [];
    siblings.push(entry);
    byParent.set(parentKey, siblings);
  }
  const rows: FlatRow[] = [];
  function visit(parentKey: string | null, depth: number): void {
    for (const entry of byParent.get(parentKey) ?? []) {
      rows.push({ entry, depth });
      visit(entry.localId, depth + 1);
    }
  }
  visit(null, 0);
  return rows;
}

export function DiffTree({
  entries,
  selectedId,
  onSelect,
  filterAction,
  filterText,
  onToggleExclude,
}: {
  entries: DryRunDiffEntry[];
  selectedId: string | null;
  onSelect: (localId: string) => void;
  filterAction: string | null;
  filterText: string;
  onToggleExclude: (localId: string, excluded: boolean) => void;
}): React.ReactElement {
  const rows = useMemo(() => {
    const allRows = buildFlatRows(entries);
    return allRows.filter((row) => {
      const matchesAction = !filterAction || row.entry.action === filterAction;
      const matchesText = !filterText || row.entry.title.toLowerCase().includes(filterText.toLowerCase());
      return matchesAction && matchesText;
    });
  }, [entries, filterAction, filterText]);

  const listRef = useRef<VariableSizeList>(null);
  const sizeMap = useRef<Map<number, number>>(new Map());

  const getItemSize = useCallback((index: number) => sizeMap.current.get(index) ?? DEFAULT_ROW_HEIGHT, []);

  const setRowSize = useCallback((index: number, size: number) => {
    if (sizeMap.current.get(index) === size) return;
    sizeMap.current.set(index, size);
    listRef.current?.resetAfterIndex(index);
  }, []);

  // `rows` changing (edit/add/exclude/filter) may shift indices or change
  // content height -- clear the whole cache and let mounted rows re-measure
  // via MeasuredRow's mount-time report. Coarse but correct; per-row diffing
  // isn't worth it at this data volume.
  useEffect(() => {
    sizeMap.current.clear();
    listRef.current?.resetAfterIndex(0);
  }, [rows]);

  return (
    <VariableSizeList
      ref={listRef}
      height={600}
      width="100%"
      itemCount={rows.length}
      itemSize={getItemSize}
      estimatedItemSize={DEFAULT_ROW_HEIGHT}
    >
      {({ index, style }) => {
        const row = rows[index];
        return (
          <div style={style}>
            <MeasuredRow index={index} onMeasure={setRowSize}>
              <ListItemButton
                key={row.entry.localId}
                sx={{ pl: `${row.depth * 16 + 16}px`, opacity: row.entry.excluded ? 0.5 : 1, alignItems: 'flex-start' }}
                selected={row.entry.localId === selectedId}
                onClick={() => onSelect(row.entry.localId)}
                data-excluded={row.entry.excluded ? 'true' : 'false'}
              >
                <Checkbox
                  inputProps={{ 'aria-label': 'exclude' }}
                  checked={!!row.entry.excluded}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => onToggleExclude(row.entry.localId, e.target.checked)}
                />
                <ActionBadge action={row.entry.action} existingAdoId={row.entry.existingAdoId} />
                <ListItemText
                  primary={row.entry.title}
                  secondary={
                    <>
                      <TagChips tags={row.entry.tags} />
                      <TraceLinkChips links={row.entry.traceLinks} />
                    </>
                  }
                  sx={row.entry.excluded ? { textDecoration: 'line-through' } : undefined}
                />
              </ListItemButton>
            </MeasuredRow>
          </div>
        );
      }}
    </VariableSizeList>
  );
}
