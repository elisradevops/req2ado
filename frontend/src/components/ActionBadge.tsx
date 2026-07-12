import Chip from '@mui/material/Chip';
import { themeTokens } from '../theme/tokens';

export function ActionBadge({ action, existingAdoId }: { action: 'create' | 'reuse' | 'dedup_skip'; existingAdoId?: number | null }): React.ReactElement {
  if (action === 'create') return <Chip label="CREATE" size="small" sx={{ backgroundColor: themeTokens.color.success, color: '#fff' }} />;
  if (action === 'reuse') return <Chip label={`REUSE #${existingAdoId ?? '?'}`} size="small" sx={{ backgroundColor: themeTokens.color.info, color: '#fff' }} />;
  return <Chip label="SKIP · dup" size="small" sx={{ backgroundColor: themeTokens.color.warning, color: '#fff' }} />;
}
