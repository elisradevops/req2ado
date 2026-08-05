import type { ReactNode } from 'react';
import { DropdownMenu as RadixDropdownMenu } from 'radix-ui';
import { cn } from '../lib/cn';

export function DropdownMenu({ trigger, children }: { trigger: ReactNode; children: ReactNode }): React.ReactElement {
  return (
    <RadixDropdownMenu.Root>
      <RadixDropdownMenu.Trigger asChild>{trigger}</RadixDropdownMenu.Trigger>
      <RadixDropdownMenu.Portal>
        <RadixDropdownMenu.Content
          align="end"
          sideOffset={8}
          className="z-40 w-[266px] origin-top-right rounded-md border border-hairline-strong bg-surface py-1 shadow-popover data-[state=open]:animate-[popIn_var(--duration-base)_var(--ease-out)] data-[state=closed]:animate-[popOut_var(--duration-exit)_var(--ease-in)]"
        >
          {children}
        </RadixDropdownMenu.Content>
      </RadixDropdownMenu.Portal>
    </RadixDropdownMenu.Root>
  );
}

export function DropdownMenuLabel({ children }: { children: ReactNode }): React.ReactElement {
  return <div className="border-b border-hairline px-3.5 py-2.5">{children}</div>;
}

export function DropdownMenuGroup({ children }: { children: ReactNode }): React.ReactElement {
  return <div className="border-b border-hairline py-1 last:border-b-0">{children}</div>;
}

export function DropdownMenuItem({
  onSelect,
  danger,
  children,
}: {
  onSelect?: () => void;
  danger?: boolean;
  children: ReactNode;
}): React.ReactElement {
  return (
    <RadixDropdownMenu.Item
      onSelect={onSelect}
      className={cn(
        'flex cursor-pointer items-center gap-2.5 px-3.5 py-1.5 text-sm outline-none transition-colors duration-instant',
        danger ? 'text-danger data-[highlighted]:bg-danger-soft' : 'text-ink-1 data-[highlighted]:bg-accent-soft data-[highlighted]:text-accent-ink',
      )}
    >
      {children}
    </RadixDropdownMenu.Item>
  );
}
