import Chip from '@mui/material/Chip';
import { themeTokens } from '../theme/tokens';

const STATUS_CONFIG: Record<string, { label: string; color: string }> = {
  pending: { label: 'Pending', color: themeTokens.color.textSecondary },
  running: { label: 'Running', color: themeTokens.color.liveAccent },
  diff_ready: { label: 'Diff Ready', color: themeTokens.color.info },
  writing: { label: 'Writing', color: themeTokens.color.liveAccent },
  succeeded: { label: 'Succeeded', color: themeTokens.color.success },
  failed: { label: 'Failed', color: themeTokens.color.danger },
  rejected: { label: 'Rejected', color: themeTokens.color.textSecondary },
};

export function StatusChip({ status }: { status: string }): React.ReactElement {
  const config = STATUS_CONFIG[status] ?? { label: status, color: themeTokens.color.textSecondary };
  return <Chip label={config.label} sx={{ backgroundColor: config.color, color: '#fff' }} size="small" />;
}
