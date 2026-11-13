import { useId, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '../lib/cn';

// DESIGN.md §11.3.2b: every disclosure uses the same chevron and the same mechanics, closed by default. The summary sits in the
// same button as the title, so one click target covers the whole strip, and a closed disclosure has none of its content in the page.
export function Disclosure({
  title,
  summary,
  defaultOpen = false,
  className,
  children,
}: {
  title: string;
  /** What is worth knowing without opening it, on the same line. */
  summary?: React.ReactNode;
  defaultOpen?: boolean;
  className?: string;
  children: React.ReactNode;
}): React.ReactElement {
  const [open, setOpen] = useState(defaultOpen);
  const regionId = useId();
  return (
    <section className={cn('rounded-md border border-hairline bg-surface', className)}>
      <h2 className="text-sm">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={open ? regionId : undefined}
          onClick={() => setOpen((value) => !value)}
          className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-md px-3.5 py-2.5 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          <ChevronRight
            className={cn('h-3.5 w-3.5 flex-none text-ink-3 transition-transform duration-fast ease-out', open && 'rotate-90')}
            aria-hidden="true"
          />
          <span className="font-semibold text-ink-1">{title}</span>
          {summary && <span className="text-xs text-ink-2">{summary}</span>}
        </button>
      </h2>
      {open && (
        <div id={regionId} role="region" aria-label={title} className="flex flex-col gap-3 border-t border-hairline p-3.5">
          {children}
        </div>
      )}
    </section>
  );
}
