import Stack from '@mui/material/Stack';
import Chip from '@mui/material/Chip';
import Tooltip from '@mui/material/Tooltip';

export interface KbCitation {
  sourceFile: string;
  similarity: number;
  relevance: 'relevant' | 'not_relevant' | 'unknown';
}

// Color reflects the LLM's own relevance verdict where available (a real
// judgment call, not just "was retrieved above a similarity cutoff") --
// green/red for a verified verdict, grey when verification wasn't run
// (kb_relevance_client unset) or the model's response couldn't be judged.
const RELEVANCE_COLOR: Record<KbCitation['relevance'], string> = {
  relevant: '#2e7d32',
  not_relevant: '#c62828',
  unknown: '#757575',
};

export function KbCitationChips({ citations }: { citations: KbCitation[] | undefined }): React.ReactElement {
  return (
    <Stack direction="row" spacing={0.5} flexWrap="wrap">
      {(citations ?? []).map((citation) => (
        <Tooltip
          key={citation.sourceFile}
          title={`similarity ${(citation.similarity * 100).toFixed(0)}% -- relevance: ${citation.relevance}`}
        >
          <Chip
            label={citation.sourceFile}
            size="small"
            sx={{ backgroundColor: RELEVANCE_COLOR[citation.relevance], color: '#fff' }}
          />
        </Tooltip>
      ))}
    </Stack>
  );
}
