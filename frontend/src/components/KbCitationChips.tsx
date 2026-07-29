import { Chip } from '../ui/Chip';
import { Tooltip } from '../ui/Tooltip';

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

// Leads with the LLM's own relevance verdict -- a real judgment of whether
// THIS chunk actually helped, not the raw number -- since a bare "33%
// similarity" reads to a reviewer as "this guidance barely applies," which
// misunderstands what the percentage measures. These KB documents are
// process/style guides (e.g. "how to write a good ADO work item"), not
// domain specs -- their vocabulary naturally has low text-overlap with a
// specific technical requirement even when the guidance is exactly on
// point. The percentage is a retrieval/text-overlap score, not a
// relevance measure; framed that way here instead of shown bare.
const RELEVANCE_LABEL: Record<KbCitation['relevance'], string> = {
  relevant: 'Judged relevant',
  not_relevant: 'Judged not relevant',
  unknown: 'Relevance not verified',
};

export function KbCitationChips({ citations }: { citations: KbCitation[] | undefined }): React.ReactElement {
  return (
    <div className="flex flex-wrap gap-1">
      {(citations ?? []).map((citation) => (
        <Tooltip
          key={citation.sourceFile}
          content={`${RELEVANCE_LABEL[citation.relevance]} -- retrieval text-overlap score: ${(citation.similarity * 100).toFixed(0)}% (not a relevance measure; this KB doc is a process/style guide, so overlap with a specific technical requirement is naturally low even when the guidance applies)`}
        >
          <Chip bg={RELEVANCE_COLOR[citation.relevance]} color="#fff">
            {citation.sourceFile}
          </Chip>
        </Tooltip>
      ))}
    </div>
  );
}
