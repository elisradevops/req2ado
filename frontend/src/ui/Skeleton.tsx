import { cn } from '../lib/cn';

export function Skeleton({ className }: { className?: string }): React.ReactElement {
  return (
    <span
      className={cn(
        'block animate-pulse rounded bg-[linear-gradient(90deg,var(--color-hairline)_25%,#E6EBF4_37%,var(--color-hairline)_63%)] bg-[length:400%_100%]',
        className,
      )}
      style={{ animation: 'shimmer 1.5s linear infinite' }}
    />
  );
}
