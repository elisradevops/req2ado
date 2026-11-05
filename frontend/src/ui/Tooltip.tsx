import { useEffect, useState, type ReactNode } from 'react';
import { Tooltip as RadixTooltip } from 'radix-ui';
import { Info } from 'lucide-react';

/**
 * Radix Tooltip renders in a portal at document.body by default — this is
 * what a hand-rolled CSS tooltip in the mockup needed a manual fixed-
 * position workaround for (ancestor `overflow:hidden` on every card would
 * otherwise clip it, and any ancestor hover-transform would break a
 * position:fixed child's coordinate system). Using the real primitive
 * sidesteps both classes of bug entirely instead of re-solving them by hand.
 */
export function Tooltip({ content, children, disabled = false }: { content: ReactNode; children: ReactNode; disabled?: boolean }): React.ReactElement {
  // Always controlled (Radix warns when a tooltip switches between controlled and uncontrolled). `disabled` keeps the tree the same shape and just
  // never opens it, so a child that sometimes needs a tooltip is not remounted (and does not lose focus) when that changes.
  const [open, setOpen] = useState(false);
  // Radix only reports a change when it differs from the `open` it was given. While disabled that is `false`, so a hover's open request would be
  // recorded here but its matching close never reported, and the tooltip would reappear stuck open when re-enabled. Hence: never record an open
  // request while disabled, and drop any open state when it becomes disabled. (On the render where `disabled` turns true, the `disabled ? false`
  // override below is what hides the stale `open`; the effect then clears it after commit.)
  // Known, cosmetic: Radix's Provider notes a disabled hover as "recently opened" (its close is never reported), so the first hover after
  // re-enabling can open without the 200ms delay. Each Tooltip has its own Provider, so it cannot leak to other tooltips.
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  return (
    <RadixTooltip.Provider delayDuration={200}>
      <RadixTooltip.Root open={disabled ? false : open} onOpenChange={(next) => setOpen(disabled ? false : next)}>
        <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
        <RadixTooltip.Portal>
          <RadixTooltip.Content
            sideOffset={8}
            collisionPadding={8}
            // DESIGN.md §5: Overlay category (Dialog/Popover/DropdownMenu/Tooltip) is radius md.
            className="z-50 max-w-[280px] rounded-md bg-ink-1 px-2.5 py-2 text-xs leading-relaxed text-ink-on-dark shadow-popover"
          >
            {content}
            <RadixTooltip.Arrow className="fill-ink-1" />
          </RadixTooltip.Content>
        </RadixTooltip.Portal>
      </RadixTooltip.Root>
    </RadixTooltip.Provider>
  );
}

/** The app's one standard way to explain anything in-place: an info icon + tooltip. */
export function InfoTip({ content, label = 'More information' }: { content: ReactNode; label?: string }): React.ReactElement {
  return (
    <Tooltip content={content}>
      <button
        type="button"
        aria-label={label}
        // relative + the absolutely-positioned ::before expander give this a
        // 24x24 CSS-px hit target (DESIGN.md §13) without inflating the
        // visible 15px glyph circle itself.
        className="relative inline-grid h-[15px] w-[15px] flex-none place-items-center rounded-full border border-hairline-strong bg-surface text-micro font-bold text-ink-3 transition-colors duration-fast ease-out hover:border-accent hover:bg-accent hover:text-white before:absolute before:-inset-[4.5px] before:content-['']"
      >
        i
      </button>
    </Tooltip>
  );
}
