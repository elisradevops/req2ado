import { CircleCheck, CircleX, Info, TriangleAlert } from 'lucide-react';

export type Severity = 'info' | 'success' | 'warning' | 'error';

// Shared by Alert (inline banners) and ToastProvider (transient toasts) --
// both render one of these four severities and must use the identical icon
// for each, so this is the single place that mapping is declared.
export const SEVERITY_ICON: Record<Severity, typeof Info> = {
  info: Info,
  success: CircleCheck,
  warning: TriangleAlert,
  error: CircleX,
};
