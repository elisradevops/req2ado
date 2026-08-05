import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '../lib/cn';
import { Spinner } from './Spinner';

export type ButtonVariant = 'primary' | 'outline' | 'ghost' | 'danger' | 'cta';
export type ButtonSize = 'sm' | 'md';

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: 'bg-action text-action-ink hover:bg-action-hover',
  outline: 'bg-surface text-action border border-field-border hover:bg-accent-soft hover:border-accent hover:text-accent-ink',
  ghost: 'bg-transparent text-ink-2 hover:bg-canvas hover:text-ink-1',
  danger: 'bg-surface text-danger border border-danger-border hover:bg-danger-soft',
  cta: 'bg-signal text-signal-ink border border-signal-border font-semibold shadow-cta hover:bg-signal-hover hover:shadow-cta-attention',
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: 'text-xs px-2.5 py-1 gap-1.5',
  md: 'text-sm px-3.5 py-1.5 gap-1.5',
};

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize; loading?: boolean }
>(function Button({ variant = 'primary', size = 'md', className, disabled, loading, children, ...props }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        'inline-flex items-center justify-center rounded-sm font-semibold whitespace-nowrap transition-[color,background-color,border-color,box-shadow,transform] duration-fast ease-out active:scale-[0.98]',
        VARIANT_CLASSES[variant],
        SIZE_CLASSES[size],
        // Native <button> defaults to cursor:default per the UA stylesheet
        // (only <a href> gets pointer for free) -- confirmed real complaint
        // ("no click icon when hovering on the buttons"). Kept as its own
        // conditional branch (not merged into the base classes above) so it
        // never fights the disabled branch's own cursor-not-allowed for
        // which utility wins.
        disabled || loading ? 'cursor-not-allowed pointer-events-none bg-canvas text-ink-3 border border-hairline shadow-none' : 'cursor-pointer',
        className,
      )}
      {...props}
    >
      {loading && <Spinner className="h-3.5 w-3.5" />}
      {children}
    </button>
  );
});
