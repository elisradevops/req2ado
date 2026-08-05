import { cn } from '../lib/cn';

export function Skeleton({ className }: { className?: string }): React.ReactElement {
  return (
    <span
      className={cn(
        'block rounded-sm bg-[linear-gradient(90deg,var(--color-hairline)_25%,var(--color-shimmer-highlight)_37%,var(--color-hairline)_63%)] bg-[length:400%_100%]',
        className,
      )}
      style={{ animation: 'shimmer var(--duration-ambient) var(--ease-linear) infinite' }}
    />
  );
}
