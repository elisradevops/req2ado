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
      {/* The selected trigger's aria-controls must resolve to a mounted
          panel; Radix only provides one if its Content is rendered. tabIndex -1:
          Radix's default 0 would add a tab stop (and a ring round the whole
          tree) in front of the content's own focusable controls. */}
      <RadixTabs.Content key={value} value={value} tabIndex={-1} className="animate-[fadeIn_var(--duration-base)_var(--ease-out)]">
        {children}
      </RadixTabs.Content>
    </RadixTabs.Root>
  );
}
