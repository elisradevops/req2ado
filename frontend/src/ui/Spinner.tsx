import { cn } from '../lib/cn';

export function Spinner({ className }: { className?: string }): React.ReactElement {
  return (
    <span
      className={cn('inline-block h-3 w-3 flex-none rounded-full border-[1.6px] border-current border-t-transparent', className)}
      style={{ animation: 'spin 0.7s linear infinite' }}
      aria-hidden="true"
    />
  );
}
