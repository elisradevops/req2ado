import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { Toast as RadixToast } from 'radix-ui';
import { CircleCheck, CircleX, Info, TriangleAlert, X } from 'lucide-react';
import { cn } from '../lib/cn';

type Severity = 'error' | 'info' | 'success' | 'warning';

interface ToastItem {
  id: number;
  message: string;
  severity: Severity;
}

interface ToastContextValue {
  showToast: (message: string, severity: Severity) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const SEVERITY_ICON: Record<Severity, typeof Info> = {
  info: Info,
  success: CircleCheck,
  warning: TriangleAlert,
  error: CircleX,
};

const SEVERITY_ICON_CLASS: Record<Severity, string> = {
  info: 'text-info',
  success: 'text-ok',
  warning: 'text-warning',
  error: 'text-danger',
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

  return (
    <ToastContext.Provider value={{ showToast }}>
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
              className="flex min-w-[250px] max-w-[360px] items-start gap-2.5 rounded-md bg-ink-1 px-3.5 py-2.5 text-sm text-ink-on-dark shadow-dialog data-[state=open]:animate-[fadeIn_var(--duration-base)_var(--ease-out)] data-[state=closed]:animate-[fadeOut_var(--duration-exit)_var(--ease-in)] data-[swipe=end]:animate-[fadeOut_var(--duration-exit)_var(--ease-in)]"
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
