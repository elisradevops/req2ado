import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: LucideIcon;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}): React.ReactElement {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-11 text-center">
      <span className="mb-0.5 grid h-11 w-11 place-items-center rounded-md border border-hairline bg-canvas text-ink-3">
        <Icon className="h-5 w-5" />
      </span>
      <h5 className="text-sm font-semibold">{title}</h5>
      {description && <p className="max-w-[44ch] text-xs text-ink-3">{description}</p>}
      {action && <div className="mt-1.5">{action}</div>}
    </div>
  );
}
