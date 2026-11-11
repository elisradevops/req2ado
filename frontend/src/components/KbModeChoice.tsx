import { useId, type ReactNode } from 'react';
import { RadioGroup } from 'radix-ui';
import { BookMarked, Search, Sparkles, type LucideIcon } from 'lucide-react';
import type { KbRetrievalMode } from '../api/kb';
import { cn } from '../lib/cn';

// The one place that explains the two ways a knowledge-base file can be used, shared by the single-file and the batch add
// dialogs so the wording never drifts between them. Nothing is selected unless `mode` says so.

interface ModeCardProps {
  value: KbRetrievalMode;
  Icon: LucideIcon;
  title: ReactNode;
  accessibleTitle: string;
  description: string;
  detail: string;
  suggestion?: string;
}

function ModeCard({ value, Icon, title, accessibleTitle, description, detail, suggestion }: ModeCardProps): React.ReactElement {
  const id = useId();
  return (
    <RadioGroup.Item
      value={value}
      aria-label={accessibleTitle}
      aria-describedby={`${id}-description`}
      className={cn(
        'flex w-full cursor-pointer items-start gap-3 rounded-md border border-hairline-strong bg-surface p-3 text-left transition-colors duration-fast ease-out',
        'hover:border-ink-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
        'data-[state=checked]:border-accent data-[state=checked]:bg-accent-soft',
      )}
    >
      <span className="mt-0.5 flex h-8 w-8 flex-none items-center justify-center rounded-md bg-surface-alt text-ink-2">
        <Icon className="h-4 w-4" aria-hidden="true" />
      </span>
      <span id={`${id}-description`} className="flex min-w-0 flex-col gap-1">
        <span className="text-sm font-semibold text-ink-1">{title}</span>
        <span className="text-sm text-ink-2">{description}</span>
        <span className="text-xs text-ink-3">{detail}</span>
        {suggestion && (
          <span className="mt-0.5 flex items-center gap-1.5 text-xs font-medium text-accent-ink">
            <Sparkles className="h-3.5 w-3.5 flex-none" aria-hidden="true" />
            <span>{suggestion}</span>
          </span>
        )}
      </span>
    </RadioGroup.Item>
  );
}


interface KbModeChoiceProps {
  mode: KbRetrievalMode | null;
  onChange: (mode: KbRetrievalMode) => void;
  // A reason shown on the Reference card ("Suggested: ..."); a hint, never a selection.
  referenceSuggestion?: string;
  disabled?: boolean;
}

export function KbModeChoice({ mode, onChange, referenceSuggestion, disabled = false }: KbModeChoiceProps): React.ReactElement {
  return (
    <RadioGroup.Root
      value={mode ?? ''}
      onValueChange={(value) => onChange(value as KbRetrievalMode)}
      aria-label="How jobs use this document"
      disabled={disabled}
      className="flex flex-col gap-2.5"
    >
      <ModeCard
        value="retrieve"
        Icon={Search}
        accessibleTitle="Search"
        title="Search"
        description="Used only when a section of your document is similar to it."
        detail="Best for large documents, customer specifications and anything topic-specific. It costs tokens only when it is relevant."
      />
      <ModeCard
        value="always_include"
        Icon={BookMarked}
        accessibleTitle="Reference (always include)"
        title={
          <>
            Reference <span className="font-normal text-ink-3">(always include)</span>
          </>
        }
        description="The full text is added to every survey job."
        detail="Best for short, stable guides: writing standards, style guides, templates, glossaries. Every job pays for it in tokens, so keep these small."
        suggestion={referenceSuggestion}
      />
    </RadioGroup.Root>
  );
}
