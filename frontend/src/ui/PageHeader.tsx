import type { ReactNode } from 'react';

export function PageHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }): React.ReactElement {
  return (
    <div className="flex flex-wrap items-start gap-3.5">
      <div className="flex min-w-0 flex-col gap-0.5">
        <h2 className="text-[22px] font-bold tracking-tight">{title}</h2>
        {description && <span className="text-sm text-ink-3">{description}</span>}
      </div>
      {actions && <div className="ml-auto flex flex-none flex-wrap gap-2">{actions}</div>}
    </div>
  );
}
