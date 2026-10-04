import { useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { Popover } from 'radix-ui';
import { ChevronDown } from 'lucide-react';
import { cn } from '../lib/cn';
import { FieldShell } from './FieldShell';

/**
 * Was a plain <input list="..."> + <datalist> -- replaced for the exact same
 * reason ui/Select.tsx replaced native <select>: the native datalist popup
 * is browser-chrome (unstyled, dark on some platforms, positioned by the
 * browser rather than the page), which reads as visibly broken/inconsistent
 * next to every other picker in the app once those moved to a real
 * JS-positioned popup. Unlike Select, this stays free-text (a valid area
 * path may not be in the suggestion list yet, or the caller may have no
 * ADO session at all) -- so it's a real combobox, not a closed listbox: the
 * text input is always authoritative, the popover only offers suggestions.
 *
 * Deliberately mirrors Select's own trigger chrome (border, chevron,
 * padding, focus ring) -- the user explicitly asked for this to look/behave
 * like Team Project and Initial State, not like its own distinct thing.
 */
export function Combobox({
  label,
  labelExtra,
  helperText,
  fullWidth,
  className,
  id,
  value,
  onChange,
  options,
  // True while the picker's own async fetch is still in flight -- without
  // this, clicking the field before that fetch resolves opened an empty
  // popover with zero rows and no explanation, which looked identical to a
  // broken picker (confirmed live: reported as "no data when I click").
  loading,
  placeholder,
  disabled,
  // Strict pickers (free text is not a valid value) override the default
  // "type to enter one manually" row, which would be wrong for them -- and
  // also show it when a typed query matches nothing, not just when the
  // option list is empty.
  emptyText,
}: {
  label?: string;
  labelExtra?: ReactNode;
  helperText?: ReactNode;
  fullWidth?: boolean;
  className?: string;
  id?: string;
  value: string;
  onChange: (value: string) => void;
  options: string[];
  loading?: boolean;
  placeholder?: string;
  disabled?: boolean;
  emptyText?: string;
}): React.ReactElement {
  const generatedId = useId();
  const fieldId = id ?? generatedId;
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const query = value.trim().toLowerCase();
    const matches = query ? options.filter((option) => option.toLowerCase().includes(query)) : options;
    // The exact current value is a real, if imperfect, signal that typing is
    // finished -- once it matches an option outright, that option is dropped
    // from the suggestion list (nothing useful left to suggest for it).
    return matches.filter((option) => option !== value).slice(0, 20);
  }, [options, value]);

  // Always show SOMETHING once opened: real matches, a loading row while
  // the fetch is in flight, or an explicit "no matches" row -- an empty,
  // silently-closed popover is what read as broken before this fix.
  const showLoadingRow = loading && filtered.length === 0;
  const showEmptyRow = !loading && filtered.length === 0 && (emptyText !== undefined || options.length === 0);
  const popoverOpen = open && (filtered.length > 0 || showLoadingRow || showEmptyRow);

  function selectOption(option: string): void {
    onChange(option);
    setOpen(false);
    inputRef.current?.focus();
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (!open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      setOpen(true);
      return;
    }
    if (!open || filtered.length === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setHighlighted((prev) => Math.min(prev + 1, filtered.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlighted((prev) => Math.max(prev - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      selectOption(filtered[highlighted]);
    } else if (event.key === 'Escape') {
      setOpen(false);
    }
  }

  return (
    <FieldShell label={label} labelExtra={labelExtra} helperText={helperText} fullWidth={fullWidth} fieldId={fieldId}>
      <Popover.Root open={popoverOpen} onOpenChange={setOpen}>
        <Popover.Anchor asChild>
          <div className="relative w-full">
            <input
              ref={inputRef}
              id={fieldId}
              role="combobox"
              aria-expanded={open}
              aria-autocomplete="list"
              autoComplete="off"
              disabled={disabled}
              value={value}
              placeholder={placeholder}
              onChange={(event) => {
                onChange(event.target.value);
                setHighlighted(0);
                setOpen(true);
              }}
              onClick={() => setOpen(true)}
              onFocus={() => setOpen(true)}
              onKeyDown={handleKeyDown}
              className={cn(
                // Same border/padding/focus-ring as Select's trigger, plus
                // right padding to clear the chevron. DESIGN.md §7 Input
                // category: hover:border-ink-3, matching Checkbox.tsx's own
                // already-correct treatment.
                'w-full cursor-pointer rounded-sm border border-field-border bg-surface py-1.5 pl-2.5 pr-8 text-sm text-ink-1 placeholder:text-ink-3 transition-colors duration-fast ease-out hover:border-ink-3 focus:border-accent focus:outline-none focus-visible:outline-2 focus-visible:outline-accent aria-invalid:border-danger disabled:cursor-not-allowed disabled:bg-canvas disabled:text-ink-3',
                className,
              )}
            />
            <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-3" />
          </div>
        </Popover.Anchor>
        <Popover.Portal>
          <Popover.Content
            align="start"
            sideOffset={4}
            // Never steals focus from the input -- it's a live-as-you-type
            // suggestion list, not a click-triggered popover; taking focus
            // would interrupt typing after every keystroke.
            onOpenAutoFocus={(event) => event.preventDefault()}
            onCloseAutoFocus={(event) => event.preventDefault()}
            className="z-50 max-h-60 w-[var(--radix-popover-anchor-width)] overflow-y-auto rounded-sm border border-hairline-strong bg-surface p-1 shadow-popover"
          >
            {showLoadingRow && <div className="px-2.5 py-1.5 text-sm text-ink-3">Loading…</div>}
            {showEmptyRow && (
              <div className="px-2.5 py-1.5 text-sm text-ink-3">{emptyText ?? 'No suggestions -- type to enter one manually.'}</div>
            )}
            {filtered.map((option, index) => (
              <div
                key={option}
                role="option"
                aria-selected={index === highlighted}
                onMouseEnter={() => setHighlighted(index)}
                // onMouseDown (not onClick) fires before the input's onBlur,
                // so the popover's own closing-on-blur can't race the click.
                onMouseDown={(event) => {
                  event.preventDefault();
                  selectOption(option);
                }}
                className={cn(
                  'cursor-pointer select-none rounded-sm px-2.5 py-1.5 text-sm text-ink-1',
                  index === highlighted && 'bg-accent-soft text-accent-ink',
                )}
              >
                {option}
              </div>
            ))}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </FieldShell>
  );
}
