import type { ReactNode } from 'react';
import { cn } from '../lib/cn';

export function StatTile({
  value,
  label,
  accent,
  tone = 'default',
}: {
  value: ReactNode;
  label: ReactNode;
  accent?: boolean;
  tone?: 'default' | 'ok' | 'warning' | 'dim';
}): React.ReactElement {
  return (
    <div className={cn('relative overflow-hidden rounded-md border border-hairline bg-surface p-3 shadow-card', accent && 'pl-4')}>
      {accent && <span className="absolute inset-y-0 left-0 w-[3px] bg-signal" />}
      <p
        className={cn(
          'font-mono text-2xl font-semibold tracking-tight tabular-nums',
          tone === 'ok' && 'text-ok',
          tone === 'warning' && 'text-warning',
          tone === 'dim' && 'text-ink-3',
        )}
      >
        {value}
      </p>
      <p className="text-[10.5px] font-semibold uppercase tracking-wide text-ink-3">{label}</p>
    </div>
  );
}
