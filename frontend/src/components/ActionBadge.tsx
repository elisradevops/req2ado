import Chip from '@mui/material/Chip';
import { themeTokens } from '../theme/tokens';

export function ActionBadge({ action, reuseId }: { action: 'CREATE' | 'REUSE' | 'SKIP'; reuseId?: number }): React.ReactElement {
  if (action === 'CREATE') return <Chip label="CREATE" size="small" sx={{ backgroundColor: themeTokens.color.success, color: '#fff' }} />;
  if (action === 'REUSE') return <Chip label={`REUSE #${reuseId ?? '?'}`} size="small" sx={{ backgroundColor: themeTokens.color.info, color: '#fff' }} />;
  return <Chip label="SKIP · dup" size="small" sx={{ backgroundColor: themeTokens.color.warning, color: '#fff' }} />;
}
