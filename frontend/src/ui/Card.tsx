import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../lib/cn';

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>): React.ReactElement {
  return <div className={cn('bg-surface border border-hairline rounded-md shadow-card overflow-hidden', className)} {...props} />;
}

export function CardHeader({ title, action, className }: { title: ReactNode; action?: ReactNode; className?: string }): React.ReactElement {
  return (
    <div className={cn('flex items-center gap-2.5 border-b border-hairline px-4 py-2.5', className)}>
      <span className="text-sm font-semibold">{title}</span>
      {action && <span className="ml-auto flex items-center gap-2">{action}</span>}
    </div>
  );
}

export function CardBody({ className, ...props }: HTMLAttributes<HTMLDivElement>): React.ReactElement {
  return <div className={cn('p-4', className)} {...props} />;
}
