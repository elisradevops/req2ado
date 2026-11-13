import { CircleCheck, Layers, ListChecks, ShieldAlert } from 'lucide-react';
import type { ReviewGroup } from '../utils/reviewQueue';

// The four review groups as the page shows them (DESIGN.md §11.5.1): a name, the written rule that decides membership (the chip's
// tooltip), an icon (never colour alone, §13) and the off/on tones of the filter chip.
export const REVIEW_GROUP_META: Record<
  ReviewGroup,
  { title: string; rule: string; icon: typeof ListChecks; offClass: string; onClass: string }
> = {
  fix: {
    title: 'Fix before writing',
    rule: 'Open "Fix before writing" warnings. Each item needs a decision before you can write.',
    icon: ShieldAlert,
    offClass: 'border-danger-border bg-danger-soft text-danger-ink',
    onClass: 'border-danger-ink bg-danger-ink text-white',
  },
  check: {
    title: 'Check',
    rule: 'A low quality score, a review warning, or wording that strays from the source. Look at each one.',
    icon: ListChecks,
    offClass: 'border-warning-border bg-warning-soft text-warning-ink',
    onClass: 'border-warning-ink bg-warning-ink text-white',
  },
  clean: {
    title: 'Clean',
    rule: 'Nothing flagged. Approve them together after looking at a sample.',
    icon: CircleCheck,
    offClass: 'border-ok-border bg-ok-soft text-ok-ink',
    onClass: 'border-ok-ink bg-ok-ink text-white',
  },
  structure: {
    title: 'Structure',
    rule: 'Epics and Features. They are not scored, so they come last.',
    icon: Layers,
    offClass: 'border-hairline-strong bg-surface-alt text-ink-2',
    onClass: 'border-ink-2 bg-ink-2 text-white',
  },
};
