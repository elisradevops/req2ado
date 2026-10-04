import { Children, forwardRef, isValidElement, useId, type OptionHTMLAttributes, type ReactNode } from 'react';
import { Select as RadixSelect } from 'radix-ui';
import { Check, ChevronDown } from 'lucide-react';
import { cn } from '../lib/cn';
import { FieldShell } from './FieldShell';
import { Spinner } from './Spinner';

// Radix's Select.Item forbids an empty-string value (it reserves '' to mean
// "nothing selected" internally) -- but this app's callers all pass native
// <option value=""> for their "Default"/placeholder entry (ProjectPicker,
// StatePicker, AddChildForm, ChatPanel's model picker). Map '' to this
// sentinel on the way in and back to '' on the way out, so every existing
// call site keeps working unchanged.
const EMPTY_VALUE = '__select_empty__';

/**
 * Was a native <select> -- replaced because a real macOS Safari bug (native
 * select popups can render detached from their trigger after the page has
 * scrolled, a known WebKit positioning defect, not something page CSS can
 * fix) made every picker in the app look broken. Radix Select renders its
 * own JS-positioned popup instead, so this can't happen.
 *
 * Public API is unchanged from the native version: pass <option> children,
 * a value string, and onChange(event) reading event.target.value -- every
 * existing call site (ProjectPicker, StatePicker, AddChildForm, ChatPanel,
 * JobDetail's filter, NewJobWizard) needed zero changes.
 */
export const Select = forwardRef<
  HTMLButtonElement,
  {
    label?: string;
    // Rendered inline next to the label (not below the field), so an
    // InfoTip's vertical position never depends on whether THIS field or a
    // sibling field happens to have helper text under it.
    labelExtra?: ReactNode;
    helperText?: ReactNode;
    fullWidth?: boolean;
    className?: string;
    id?: string;
    name?: string;
    value?: string;
    defaultValue?: string;
    disabled?: boolean;
    // True while the options are still being fetched: the trigger is
    // disabled and says so, instead of opening an empty list.
    loading?: boolean;
    'aria-label'?: string;
    onChange?: (event: { target: { value: string; name?: string } }) => void;
    children?: ReactNode;
  }
>(function Select(
  { label, labelExtra, helperText, fullWidth, className, id, name, value, defaultValue, disabled, loading, onChange, children, ...rest },
  ref,
) {
  const generatedId = useId();
  const fieldId = id ?? generatedId;
  const ariaLabel = rest['aria-label'] ?? label;

  const options = Children.toArray(children).filter(isValidElement) as React.ReactElement<
    OptionHTMLAttributes<HTMLOptionElement>
  >[];

  function toRadixValue(raw: string | undefined): string | undefined {
    if (raw === undefined) return undefined;
    return raw === '' ? EMPTY_VALUE : raw;
  }

  function handleValueChange(next: string): void {
    onChange?.({ target: { value: next === EMPTY_VALUE ? '' : next, name } });
  }

  return (
    <FieldShell label={label} labelExtra={labelExtra} helperText={helperText} fullWidth={fullWidth} fieldId={fieldId}>
      <RadixSelect.Root
        value={toRadixValue(value)}
        defaultValue={toRadixValue(defaultValue)}
        onValueChange={handleValueChange}
        disabled={disabled || loading}
        name={name}
      >
        <RadixSelect.Trigger
          ref={ref}
          id={fieldId}
          aria-label={ariaLabel}
          // Recovers the full value on hover when the trigger is too narrow
          // to show it -- see the truncate span below.
          title={value}
          className={cn(
            // DESIGN.md §7 Input category: hover:border-ink-3, matching Checkbox.tsx's own already-correct treatment.
            'flex w-full cursor-pointer items-center justify-between gap-2 rounded-sm border border-field-border bg-surface px-2.5 py-1.5 text-sm text-ink-1 transition-colors duration-fast ease-out hover:border-ink-3 focus:border-accent focus:outline-none focus-visible:outline-2 focus-visible:outline-accent aria-invalid:border-danger disabled:cursor-not-allowed disabled:bg-canvas disabled:text-ink-3',
            className,
          )}
        >
          {/* Select.Value strips className/style itself (it hardcodes its
              own pointer-events:none) -- wrapping it is the only way to
              constrain its width. min-w-0 lets the wrapper shrink below its
              content width inside the flex row above -- without it, a value
              longer than the trigger (e.g. a long model name in a narrow
              picker) overflows raw instead of ellipsizing. */}
          <span className="min-w-0 flex-1 truncate text-left">
            {loading ? (
              <span className="flex items-center gap-1.5 text-ink-3">
                <Spinner /> Loading…
              </span>
            ) : (
              <RadixSelect.Value />
            )}
          </span>
          <RadixSelect.Icon>
            <ChevronDown className="h-3.5 w-3.5 flex-none text-ink-3" />
          </RadixSelect.Icon>
        </RadixSelect.Trigger>
        <RadixSelect.Portal>
          <RadixSelect.Content
            position="popper"
            sideOffset={4}
            className="z-50 max-h-72 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-sm border border-hairline-strong bg-surface shadow-popover"
          >
            <RadixSelect.Viewport className="p-1">
              {options.map((option) => {
                const optionValue = String(option.props.value ?? '');
                return (
                  <RadixSelect.Item
                    key={optionValue}
                    value={optionValue === '' ? EMPTY_VALUE : optionValue}
                    disabled={option.props.disabled}
                    className="relative flex cursor-pointer select-none items-center justify-between gap-2 rounded-sm py-1.5 pl-2.5 pr-7 text-sm text-ink-1 outline-none data-[disabled]:cursor-not-allowed data-[disabled]:text-ink-3 data-[highlighted]:bg-accent-soft data-[highlighted]:text-accent-ink"
                  >
                    <RadixSelect.ItemText>{option.props.children}</RadixSelect.ItemText>
                    <RadixSelect.ItemIndicator className="absolute right-2 inline-flex items-center">
                      <Check className="h-3.5 w-3.5" />
                    </RadixSelect.ItemIndicator>
                  </RadixSelect.Item>
                );
              })}
            </RadixSelect.Viewport>
          </RadixSelect.Content>
        </RadixSelect.Portal>
      </RadixSelect.Root>
    </FieldShell>
  );
});
