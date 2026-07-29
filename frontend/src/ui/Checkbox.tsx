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
        'flex h-[15px] w-[15px] flex-none items-center justify-center rounded-[3px] border border-hairline-strong bg-surface transition-colors duration-150 hover:border-navy-300 data-[state=checked]:border-navy-600 data-[state=checked]:bg-navy-600 disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
    >
      <RadixCheckbox.Indicator>
        <Check className="h-2.5 w-2.5 text-white" strokeWidth={3} />
      </RadixCheckbox.Indicator>
    </RadixCheckbox.Root>
  );
}
