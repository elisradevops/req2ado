import { Checkbox as RadixCheckbox } from 'radix-ui';
import { Check } from 'lucide-react';
import { cn } from '../lib/cn';

export function Checkbox({
  checked,
  onCheckedChange,
  disabled,
  ariaLabel,
  className,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
}): React.ReactElement {
  return (
    <RadixCheckbox.Root
      checked={checked}
      onCheckedChange={(value) => onCheckedChange(value === true)}
      disabled={disabled}
      aria-label={ariaLabel}
      className={cn(
        // relative + the absolutely-positioned ::before expander give this a
        // 24x24 CSS-px hit target (DESIGN.md §13) without inflating the
        // visible 15px box itself.
        'relative flex h-[15px] w-[15px] flex-none items-center justify-center rounded-sm border border-hairline-strong bg-surface transition-colors duration-fast ease-out hover:border-ink-3 data-[state=checked]:border-accent data-[state=checked]:bg-accent disabled:cursor-not-allowed disabled:opacity-50 before:absolute before:-inset-[4.5px] before:content-[\'\']',
        className,
      )}
    >
      <RadixCheckbox.Indicator>
        <Check className="h-2.5 w-2.5 text-white" strokeWidth={3} />
      </RadixCheckbox.Indicator>
    </RadixCheckbox.Root>
  );
}
