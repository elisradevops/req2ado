import { Switch as RadixSwitch } from 'radix-ui';
import { cn } from '../lib/cn';

// The one toggle-switch primitive in the app -- Settings' Display
// Preferences (DESIGN.md Track B, phase B11) is its first real consumer.
export function Switch({
  checked,
  onCheckedChange,
  ariaLabel,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  ariaLabel: string;
}): React.ReactElement {
  return (
    <RadixSwitch.Root
      checked={checked}
      onCheckedChange={onCheckedChange}
      aria-label={ariaLabel}
      className={cn(
        'relative h-5 w-9 flex-none cursor-pointer rounded-full border transition-colors duration-fast ease-out',
        checked ? 'border-accent bg-accent' : 'border-hairline-strong bg-surface-alt',
      )}
    >
      <RadixSwitch.Thumb
        className={cn(
          'block h-3.5 w-3.5 translate-x-0.5 rounded-full bg-white shadow-sm transition-transform duration-fast ease-out',
          checked && 'translate-x-[18px]',
        )}
      />
    </RadixSwitch.Root>
  );
}
