import type { ComponentType, ReactNode } from 'react';
import { cn } from '../lib/cn';
import { InfoTip } from './Tooltip';
import { LABEL_MICRO } from '../utils/labelMicro';

export function StatTile({
  value,
  label,
  accent,
  tone = 'default',
  interactive,
  icon: Icon,
  hint,
}: {
  value: ReactNode;
  label: ReactNode;
  accent?: boolean;
  tone?: 'default' | 'ok' | 'warning' | 'dim';
  // Opt-in hover lift (DESIGN.md §7, Surface category) -- never a default.
  interactive?: boolean;
  // DESIGN.md §11.1 -- a leading glyph identifying what's being counted.
  // lucide-react only (§10); optional so tiles with no natural icon (e.g.
  // a bare metric with no real-world referent) don't have to invent one.
  icon?: ComponentType<{ className?: string }>;
  // Plain-language meaning of the number, in-place via the app's one
  // standard InfoTip pattern -- not a second tooltip mechanism.
  hint?: ReactNode;
}): React.ReactElement {
  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-md border border-hairline bg-surface p-3 shadow-card',
        accent && 'pl-4',
        interactive && 'liftable',
      )}
    >
      {/* Accent bar is `accent` (indigo), never `signal` (DESIGN.md §15.7 --
          signal is reserved strictly for the confirm-to-ADO CTA). */}
      {accent && <span className="absolute inset-y-0 left-0 w-[3px] bg-accent" />}
      <p
        className={cn(
          'font-mono text-metric tabular-nums',
          tone === 'ok' && 'text-ok',
          tone === 'warning' && 'text-warning',
          tone === 'dim' && 'text-ink-3',
        )}
      >
        {value}
      </p>
      <p className={cn('flex items-center gap-1', LABEL_MICRO)}>
        {Icon && <Icon className="h-3.5 w-3.5 flex-none" />}
        {label}
        {hint && <InfoTip content={hint} label={`About ${typeof label === 'string' ? label : 'this number'}`} />}
      </p>
    </div>
  );
}
