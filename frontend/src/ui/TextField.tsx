import { forwardRef, useId, type InputHTMLAttributes, type TextareaHTMLAttributes, type ReactNode } from 'react';
import { cn } from '../lib/cn';

const FIELD_CLASSES =
  // DESIGN.md §7 Input category: hover:border-ink-3, matching Checkbox.tsx's own already-correct treatment.
  'w-full rounded-sm border border-field-border bg-surface px-2.5 py-1.5 text-sm text-ink-1 placeholder:text-ink-3 transition-colors duration-fast ease-out hover:border-ink-3 focus:border-accent focus:outline-none focus-visible:outline-2 focus-visible:outline-accent aria-invalid:border-danger disabled:bg-canvas disabled:text-ink-3';

interface FieldWrapperProps {
  label?: string;
  // Rendered inline next to the label, not below the input -- decouples an
  // InfoTip's vertical position from whether THIS field or a sibling field
  // (e.g. side-by-side in a grid) happens to have helper text under it.
  // Without this, an icon placed via an external `items-end` wrapper tracks
  // the tallest sibling's bottom edge, so two fields of different content
  // height visibly misalign (confirmed in NewJobWizard's Initial State /
  // Iteration Path row).
  labelExtra?: ReactNode;
  helperText?: ReactNode;
  fullWidth?: boolean;
  className?: string;
}

export const TextField = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & FieldWrapperProps>(
  function TextField({ label, labelExtra, helperText, fullWidth, className, id, ...props }, ref) {
    const generatedId = useId();
    const fieldId = id ?? generatedId;
    return (
      <div className={cn('flex flex-col gap-1.5', fullWidth && 'w-full')}>
        {(label || labelExtra) && (
          <div className="flex items-center justify-between gap-1.5">
            {label && (
              <label htmlFor={fieldId} className="text-meta font-semibold uppercase tracking-wide text-ink-2">
                {label}
              </label>
            )}
            {labelExtra}
          </div>
        )}
        <input ref={ref} id={fieldId} className={cn(FIELD_CLASSES, className)} {...props} />
        {helperText && <span className="text-xs text-ink-3">{helperText}</span>}
      </div>
    );
  },
);

export const TextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & FieldWrapperProps>(
  function TextArea({ label, helperText, fullWidth, className, id, ...props }, ref) {
    const generatedId = useId();
    const fieldId = id ?? generatedId;
    return (
      <div className={cn('flex flex-col gap-1.5', fullWidth && 'w-full')}>
        {label && (
          <label htmlFor={fieldId} className="text-meta font-semibold uppercase tracking-wide text-ink-2">
            {label}
          </label>
        )}
        <textarea ref={ref} id={fieldId} className={cn(FIELD_CLASSES, 'min-h-[80px] resize-y', className)} {...props} />
        {helperText && <span className="text-xs text-ink-3">{helperText}</span>}
      </div>
    );
  },
);
