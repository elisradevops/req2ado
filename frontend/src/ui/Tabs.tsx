import type { ReactNode } from 'react';
import { Tabs as RadixTabs } from 'radix-ui';
import { cn } from '../lib/cn';

export function Tabs({
  value,
  onValueChange,
  tabs,
  children,
}: {
  value: string;
  onValueChange: (value: string) => void;
  tabs: { value: string; label: ReactNode }[];
  children?: ReactNode;
}): React.ReactElement {
  return (
    <RadixTabs.Root value={value} onValueChange={onValueChange}>
      <RadixTabs.List className="flex border-b border-hairline-strong">
        {tabs.map((tab) => (
          <RadixTabs.Trigger
            key={tab.value}
            value={tab.value}
            className={cn(
              'border-b-2 border-transparent px-3 py-2 text-sm font-semibold text-ink-3 transition-colors',
              'data-[state=active]:border-accent data-[state=active]:text-ink-1',
              'hover:text-ink-1',
            )}
          >
            {tab.label}
          </RadixTabs.Trigger>
        ))}
      </RadixTabs.List>
      <div key={value} className="animate-[fadeIn_var(--duration-base)_var(--ease-out)]">
        {children}
      </div>
    </RadixTabs.Root>
  );
}
