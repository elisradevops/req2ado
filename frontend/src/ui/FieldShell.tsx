import type { ReactNode } from 'react';
import { cn } from '../lib/cn';

// The label-row + helper-text wrapper shared by every form field
// (TextField/TextArea, Select, Combobox) -- was duplicated verbatim across
// all three; this is the one source. `labelExtra` renders inline next to
// the label (not below the input), so an InfoTip's vertical position never
// depends on whether THIS field or a sibling field happens to have helper
// text under it (see TextField's own original doc comment for the live bug
// this fixes).
export function FieldShell({
  label,
  labelExtra,
  helperText,
  fullWidth,
  fieldId,
  children,
}: {
  label?: string;
  labelExtra?: ReactNode;
  helperText?: ReactNode;
  fullWidth?: boolean;
  fieldId: string;
  children: ReactNode;
}): React.ReactElement {
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
      {children}
      {helperText && <span className="text-xs text-ink-3">{helperText}</span>}
    </div>
  );
}
