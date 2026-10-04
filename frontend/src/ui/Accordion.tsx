import type { ReactNode } from 'react';
import { Accordion as RadixAccordion } from 'radix-ui';
import { ChevronRight } from 'lucide-react';
import { cn } from '../lib/cn';

// One-open-at-a-time disclosure list. Radix owns the keyboard model (arrow
// keys between triggers, Home/End) and the aria wiring; this wrapper only
// supplies the app's tokens. Content is unmounted while closed, so a closed
// row never contributes focusable children.
export function Accordion({
  value,
  onValueChange,
  children,
  className,
}: {
  value: string;
  onValueChange: (value: string) => void;
  children: ReactNode;
  className?: string;
}): React.ReactElement {
  return (
    <RadixAccordion.Root type="single" collapsible value={value} onValueChange={onValueChange} className={className}>
      {children}
    </RadixAccordion.Root>
  );
}

export function AccordionItem({
  value,
  className,
  children,
}: {
  value: string;
  className?: string;
  children: ReactNode;
}): React.ReactElement {
  return (
    <RadixAccordion.Item value={value} className={className}>
      {children}
    </RadixAccordion.Item>
  );
}

// Header + trigger as one unit. Anything that must be a sibling button
// (e.g. a row action) is rendered by the caller outside the trigger, since
// buttons can't nest.
export function AccordionTrigger({ children, className }: { children: ReactNode; className?: string }): React.ReactElement {
  return (
    <RadixAccordion.Header className="m-0 min-w-0 text-sm font-normal">
      <RadixAccordion.Trigger
        className={cn(
          'group flex w-full min-w-0 items-start gap-2 rounded-sm text-left',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
          className,
        )}
      >
        <ChevronRight className="mt-0.5 h-3.5 w-3.5 flex-none text-ink-3 transition-transform duration-fast ease-out group-data-[state=open]:rotate-90" />
        <span className="min-w-0 flex-1">{children}</span>
      </RadixAccordion.Trigger>
    </RadixAccordion.Header>
  );
}

export function AccordionContent({ children, className }: { children: ReactNode; className?: string }): React.ReactElement {
  return <RadixAccordion.Content className={className}>{children}</RadixAccordion.Content>;
}
