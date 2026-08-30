import type { ReactNode } from 'react';
import { CircleX } from 'lucide-react';
import { cn } from '../lib/cn';
import { SEVERITY_ICON } from './severityIcons';

export type AlertSeverity = 'info' | 'warning' | 'success' | 'error';

const SEVERITY_CLASSES: Record<AlertSeverity, string> = {
  info: 'bg-info-soft border-info-border text-info-ink',
  warning: 'bg-warning-soft border-warning-border text-warning-ink',
  success: 'bg-ok-soft border-ok-border text-ok-ink',
  error: 'bg-danger-soft border-danger-border text-danger-ink',
};

export function Alert({
  severity = 'info',
  onClose,
  children,
  className,
}: {
  severity?: AlertSeverity;
  onClose?: () => void;
  children: ReactNode;
  className?: string;
}): React.ReactElement {
  const Icon = SEVERITY_ICON[severity];
  return (
    <div role="alert" className={cn('flex items-start gap-2.5 rounded-sm border px-3.5 py-2.5 text-sm', SEVERITY_CLASSES[severity], className)}>
      <Icon className="mt-0.5 h-4 w-4 flex-none" />
      <div className="flex-1">{children}</div>
      {onClose && (
        <button type="button" onClick={onClose} aria-label="Dismiss" className="flex-none text-current opacity-60 hover:opacity-100">
          <CircleX className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
