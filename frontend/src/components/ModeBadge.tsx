import { Chip } from '../ui/Chip';

export function ModeBadge({ mode }: { mode: 'baseline' | 'survey' }): React.ReactElement {
  return (
    <Chip className="border border-navy-300/60 font-mono text-[10.5px] tracking-wide text-navy-600" bg="transparent">
      {mode === 'survey' ? 'SURVEY' : 'BASELINE'}
    </Chip>
  );
}
