import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '../lib/cn';

export type ButtonVariant = 'primary' | 'outline' | 'ghost' | 'danger' | 'cta';
export type ButtonSize = 'sm' | 'md';

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: 'bg-navy-600 text-white hover:bg-navy-700',
  outline: 'bg-surface text-navy-600 border border-hairline-strong hover:bg-canvas hover:border-navy-300',
  ghost: 'bg-transparent text-ink-2 hover:bg-canvas hover:text-ink-1',
  danger: 'bg-surface text-danger border border-[#EFC4C7] hover:bg-[#FBE9EA]',
  cta: 'bg-signal text-navy-900 border border-[#E3C821] font-semibold shadow-[0_1px_0_rgba(122,92,0,0.22)] hover:bg-[#FFE95C] hover:shadow-[0_2px_8px_rgba(200,164,0,0.34)]',
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: 'text-xs px-2.5 py-1 gap-1.5',
  md: 'text-sm px-3.5 py-1.5 gap-1.5',
};

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize }>(
  function Button({ variant = 'primary', size = 'md', className, disabled, ...props }, ref) {
    return (
      <button
        ref={ref}
        type="button"
        disabled={disabled}
        className={cn(
          'inline-flex items-center justify-center rounded-sm font-semibold whitespace-nowrap transition-colors duration-150 ease-in-out active:translate-y-px',
          VARIANT_CLASSES[variant],
          SIZE_CLASSES[size],
          disabled && 'bg-canvas text-ink-3 border border-hairline shadow-none cursor-not-allowed pointer-events-none',
          className,
        )}
        {...props}
      />
    );
  },
);
