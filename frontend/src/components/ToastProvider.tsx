import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { Toast as RadixToast } from 'radix-ui';
import { X } from 'lucide-react';
import { cn } from '../lib/cn';
import { SEVERITY_ICON, type Severity } from '../ui/severityIcons';

interface ToastItem {
  id: number;
  message: string;
  severity: Severity;
}

interface ToastContextValue {
  showToast: (message: string, severity: Severity) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const SEVERITY_ICON_CLASS: Record<Severity, string> = {
  info: 'text-info',
  success: 'text-ok',
  warning: 'text-warning',
  error: 'text-danger',
};

// DESIGN.md §5's geometry table: "Feedback | Alert / Toast: radius md.
// Left accent bar 4px in the severity's fill colour." Previously only the
// icon recolored per severity -- info/success/warning/error toasts were
// otherwise visually identical. Same base severity tokens the icon
// already uses (not the *-soft light tint, which is for a light
// background -- the toast itself stays a dark surface per §13's own rule
// grouping toasts with the rail/NarrationTicker/tooltips).
const SEVERITY_BORDER_CLASS: Record<Severity, string> = {
  info: 'border-l-info',
  success: 'border-l-ok',
  warning: 'border-l-warning',
  error: 'border-l-danger',
};

let nextToastId = 0;

export function ToastProvider({ children }: { children: ReactNode }): React.ReactElement {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const showToast = useCallback((message: string, severity: Severity) => {
    const id = nextToastId++;
    setToasts((prev) => [...prev, { id, message, severity }]);
  }, []);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  }, []);

  // A fresh { showToast } object literal every render would re-render
  // every consumer in the tree on each toast add/dismiss (any context
  // value change re-renders every subscriber, object identity or not).
  // showToast itself is already a stable useCallback reference, so this
  // only ever produces a new object when it doesn't need to.
  const contextValue = useMemo(() => ({ showToast }), [showToast]);

  return (
    <ToastContext.Provider value={contextValue}>
      {children}
      <RadixToast.Provider swipeDirection="right" duration={4400}>
        {toasts.map((toast) => {
          const Icon = SEVERITY_ICON[toast.severity];
          return (
            <RadixToast.Root
              key={toast.id}
              onOpenChange={(open) => {
                if (!open) dismiss(toast.id);
              }}
              className={cn(
                'flex min-w-[250px] max-w-[360px] items-start gap-2.5 rounded-md border-l-4 bg-ink-1 px-3.5 py-2.5 text-sm text-ink-on-dark shadow-dialog data-[state=open]:animate-[fadeIn_var(--duration-base)_var(--ease-out)] data-[state=closed]:animate-[fadeOut_var(--duration-exit)_var(--ease-in)] data-[swipe=end]:animate-[fadeOut_var(--duration-exit)_var(--ease-in)]',
                SEVERITY_BORDER_CLASS[toast.severity],
              )}
            >
              <Icon className={cn('mt-0.5 h-4 w-4 flex-none', SEVERITY_ICON_CLASS[toast.severity])} />
              <RadixToast.Description className="flex-1">{toast.message}</RadixToast.Description>
              <RadixToast.Close aria-label="Dismiss" className="flex-none text-ink-on-dark-dim hover:text-white">
                <X className="h-3.5 w-3.5" />
              </RadixToast.Close>
            </RadixToast.Root>
          );
        })}
        <RadixToast.Viewport className="fixed bottom-4 right-4 z-[100] flex w-[380px] max-w-[calc(100vw-32px)] flex-col gap-2 outline-none" />
      </RadixToast.Provider>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used within a ToastProvider');
  return context;
}
