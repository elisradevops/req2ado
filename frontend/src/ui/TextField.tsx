import { forwardRef, useId, type InputHTMLAttributes, type TextareaHTMLAttributes, type ReactNode } from 'react';
import { cn } from '../lib/cn';
import { FieldShell } from './FieldShell';

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
      <FieldShell label={label} labelExtra={labelExtra} helperText={helperText} fullWidth={fullWidth} fieldId={fieldId}>
        <input ref={ref} id={fieldId} className={cn(FIELD_CLASSES, className)} {...props} />
      </FieldShell>
    );
  },
);

export const TextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & FieldWrapperProps>(
  function TextArea({ label, helperText, fullWidth, className, id, ...props }, ref) {
    const generatedId = useId();
    const fieldId = id ?? generatedId;
    return (
      <FieldShell label={label} helperText={helperText} fullWidth={fullWidth} fieldId={fieldId}>
        <textarea ref={ref} id={fieldId} className={cn(FIELD_CLASSES, 'min-h-[80px] resize-y', className)} {...props} />
      </FieldShell>
    );
  },
);
