import { Check, X, type LucideIcon } from 'lucide-react';
import { Chip } from '../ui/Chip';
import { Tooltip } from '../ui/Tooltip';

export interface KbCitation {
  sourceFile: string;
  similarity: number;
  relevance: 'relevant' | 'not_relevant' | 'unknown';
}

interface RelevancePresentation {
  bg: string;
  color: string;
  border: string;
  // Short label rendered directly ON the chip -- a reviewer previously had
  // to hover to learn what the color meant.
  chipLabel: string;
  // Longer form used only in the hover tooltip, alongside the retrieval
  // score explanation -- kept separate from chipLabel, which needs to fit
  // inline without hovering.
  tooltipLabel: string;
  // null for "unknown" -- there's no positive/negative verdict to depict.
  Icon: LucideIcon | null;
}

// Color reflects the LLM's own relevance verdict where available (a real
// judgment call, not just "was retrieved above a similarity cutoff") --
// the app's existing semantic soft/ink/border token triples (same ones
// KbFileDetailPane.tsx already uses), not one-off hex values, so this
// chip reads consistently with the rest of the app instead of introducing
// its own color language.
const RELEVANCE_PRESENTATION: Record<KbCitation['relevance'], RelevancePresentation> = {
  relevant: {
    bg: 'var(--color-ok-soft)',
    color: 'var(--color-ok-ink)',
    border: 'var(--color-ok-border)',
    chipLabel: 'Relevant',
    tooltipLabel: 'Judged relevant',
    Icon: Check,
  },
  not_relevant: {
    bg: 'var(--color-danger-soft)',
    color: 'var(--color-danger-ink)',
    border: 'var(--color-danger-border)',
    chipLabel: 'Not relevant',
    tooltipLabel: 'Judged not relevant',
    Icon: X,
  },
  unknown: {
    bg: 'var(--color-surface-alt)',
    color: 'var(--color-ink-3)',
    border: 'var(--color-hairline-strong)',
    chipLabel: 'Unverified',
    tooltipLabel: 'Relevance not verified',
    Icon: null,
  },
};

export function KbCitationChips({ citations }: { citations: KbCitation[] | undefined }): React.ReactElement {
  return (
    <div className="flex flex-wrap gap-1">
      {(citations ?? []).map((citation) => {
        const presentation = RELEVANCE_PRESENTATION[citation.relevance];
        const Icon = presentation.Icon;
        // A malformed/missing similarity value must not render a literal
        // "NaN%" in the tooltip -- NaN.toFixed(0) returns the string "NaN",
        // not an error, so this needs its own explicit guard.
        const similarityPercent = Number.isFinite(citation.similarity) ? `${(citation.similarity * 100).toFixed(0)}%` : 'unknown';
        return (
          <Tooltip
            key={citation.sourceFile}
            content={`${presentation.tooltipLabel} -- retrieval text-overlap score: ${similarityPercent} (not a relevance measure; this KB doc is a process/style guide, so overlap with a specific technical requirement is naturally low even when the guidance applies)`}
          >
            <Chip bg={presentation.bg} color={presentation.color} className="border" style={{ borderColor: presentation.border }}>
              {Icon && <Icon className="h-3 w-3" />}
              {presentation.chipLabel} · {citation.sourceFile}
            </Chip>
          </Tooltip>
        );
      })}
    </div>
  );
}
