import Stack from '@mui/material/Stack';
import Chip from '@mui/material/Chip';

interface TraceLinkView {
  displayName: string;
  targetKind: 'intraJob' | 'crossJob';
  targetLocalId?: string;
  targetCustomerId?: string;
  resolvedAdoId?: number;
  resolutionStatus: 'resolved' | 'unresolved' | 'pending';
}

function targetLabel(link: TraceLinkView): string {
  if (link.resolvedAdoId != null) return `WI-${link.resolvedAdoId}`;
  if (link.targetCustomerId) return link.targetCustomerId;
  if (link.targetLocalId) return link.targetLocalId;
  return '?';
}

export function TraceLinkChips({ links }: { links?: TraceLinkView[] }): React.ReactElement | null {
  if (!links || links.length === 0) return null;
  return (
    <Stack direction="row" spacing={0.5} flexWrap="wrap">
      {links.map((link, i) => (
        <Chip
          key={`${link.displayName}-${i}`}
          size="small"
          data-resolution-status={link.resolutionStatus}
          color={link.resolutionStatus === 'unresolved' ? 'warning' : 'default'}
          label={`${link.displayName} → ${targetLabel(link)}`}
        />
      ))}
    </Stack>
  );
}
