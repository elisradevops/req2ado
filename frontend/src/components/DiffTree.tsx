import { useMemo } from 'react';
import { FixedSizeList } from 'react-window';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import Checkbox from '@mui/material/Checkbox';
import { ActionBadge } from './ActionBadge';
import { TagChips } from './TagChips';

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

  return (
    <FixedSizeList height={600} width="100%" itemCount={rows.length} itemSize={56}>
      {({ index, style }) => {
        const row = rows[index];
        return (
          <ListItemButton
            key={row.entry.localId}
            style={{ ...style, paddingLeft: row.depth * 16 + 16, opacity: row.entry.excluded ? 0.5 : 1 }}
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
              secondary={<TagChips tags={row.entry.tags} />}
              sx={row.entry.excluded ? { textDecoration: 'line-through' } : undefined}
            />
          </ListItemButton>
        );
      }}
    </FixedSizeList>
  );
}
