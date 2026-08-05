import type { ReactNode } from 'react';
import { cn } from '../lib/cn';

export function StatTile({
  value,
  label,
  accent,
  tone = 'default',
  interactive,
}: {
  value: ReactNode;
  label: ReactNode;
  accent?: boolean;
  tone?: 'default' | 'ok' | 'warning' | 'dim';
  // Opt-in hover lift (DESIGN.md §7, Surface category) -- never a default.
  interactive?: boolean;
}): React.ReactElement {
  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-md border border-hairline bg-surface p-3 shadow-card',
        accent && 'pl-4',
        interactive &&
          'lift transition-[transform,box-shadow,border-color] duration-base ease-out hover:shadow-raised hover:-translate-y-px hover:border-hairline-strong',
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
      <p className="text-micro font-semibold uppercase tracking-wide text-ink-3">{label}</p>
    </div>
  );
}
