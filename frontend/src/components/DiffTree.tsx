import { useMemo } from 'react';
import { FixedSizeList } from 'react-window';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
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
}: {
  entries: DryRunDiffEntry[];
  selectedId: string | null;
  onSelect: (localId: string) => void;
  filterAction: string | null;
  filterText: string;
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
            style={{ ...style, paddingLeft: row.depth * 16 + 16 }}
            selected={row.entry.localId === selectedId}
            onClick={() => onSelect(row.entry.localId)}
          >
            <ActionBadge action={row.entry.action} existingAdoId={row.entry.existingAdoId} />
            <ListItemText primary={row.entry.title} secondary={<TagChips tags={row.entry.tags} />} />
          </ListItemButton>
        );
      }}
    </FixedSizeList>
  );
}
