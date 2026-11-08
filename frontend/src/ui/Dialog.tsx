import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { Dialog as RadixDialog } from 'radix-ui';
import { X } from 'lucide-react';

// Tracks where the user last pressed down, so ANY Dialog instance can grow
// from/shrink into whatever button actually opened it (user-requested: "the
// dialog to open/close from/to the button") with zero changes needed at any
// of the many call sites across the app -- every caller just flips its own
// `open` boolean on a button click exactly as it already does; this
// listener alone supplies the origin point. Module-level (not a hook/ref)
// since it must exist before the FIRST Dialog ever opens and is shared
// across every Dialog instance -- there's exactly one "last thing the user
// clicked" at any moment, not one per dialog. Capture phase so this always
// sees the click before any handler can stopPropagation() it.
let lastPointerDownCenter: { x: number; y: number } | null = null;
if (typeof document !== 'undefined') {
  document.addEventListener(
    'pointerdown',
    (event) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      // closest('button, [role="button"], a') -- the actual clickable
      // control, not some inner icon/span the pointer happened to land on;
      // falls back to the raw target when the click wasn't on a control at
      // all (e.g. programmatic open with no real click to anchor to).
      const control = (target.closest('button, [role="button"], a') as HTMLElement | null) ?? target;
      const rect = control.getBoundingClientRect();
      lastPointerDownCenter = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    },
    { capture: true },
  );
}

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  maxWidthClassName = 'max-w-[440px]',
  // Escape hatch for a large, non-form dialog (e.g. a two-pane details +
  // chat layout) that needs to own its own body layout/scroll regions
  // instead of the default padded flex-column body -- avoids forking the
  // overlay/animation/header chrome into a second component just to change
  // the body wrapper. maxHeightClassName is similarly optional since only
  // a large dialog needs an explicit height constraint; the default
  // (content-sized, centered) is unaffected when omitted.
  unpadded = false,
  maxHeightClassName,
  // Where focus goes on close instead of the remembered opener, when that
  // element is connected. For a caller that hands over between dialogs, where
  // the remembered opener may be inside a dialog that is about to unmount.
  returnFocusRef,
  // false: closing moves no focus (a hand-over where another dialog or
  // control takes focus itself and a closing dialog must not steal it back).
  restoreFocus = true,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  maxWidthClassName?: string;
  unpadded?: boolean;
  maxHeightClassName?: string;
  returnFocusRef?: React.RefObject<HTMLElement | null>;
  restoreFocus?: boolean;
}): React.ReactElement {
  const contentRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  // Radix only returns focus to a Dialog.Trigger, and every caller here
  // flips its own `open` boolean instead of rendering one, so on close Radix
  // focuses a null trigger and focus falls to <body>. Remember what had
  // focus at the moment of opening (layout effect: before Radix moves focus
  // into the content) and hand it back in onCloseAutoFocus.
  useLayoutEffect(() => {
    if (open) openerRef.current = document.activeElement as HTMLElement | null;
  }, [open]);

  // Must be a layout effect (runs synchronously before paint), not a plain
  // effect -- the very first animation frame needs `transform-origin`
  // already set, or the open animation's earliest moments would scale
  // from the default 50%/50% center before this ever gets a chance to
  // apply. `lastPointerDownCenter` is read once here (whatever button was
  // last pressed) rather than threaded in as a prop -- see its own
  // docstring for why that keeps every caller across the app unchanged.
  useLayoutEffect(() => {
    const el = contentRef.current;
    if (!open || !el || !lastPointerDownCenter) return;
    const rect = el.getBoundingClientRect();
    el.style.setProperty('--dialog-origin-x', `${lastPointerDownCenter.x - rect.left}px`);
    el.style.setProperty('--dialog-origin-y', `${lastPointerDownCenter.y - rect.top}px`);
  }, [open]);

  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-40 bg-scrim data-[state=open]:animate-[fadeIn_var(--duration-base)_var(--ease-out)] data-[state=closed]:animate-[fadeOut_var(--duration-exit)_var(--ease-in)]" />
        <RadixDialog.Content
          ref={contentRef}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const opener = openerRef.current;
            openerRef.current = null;
            if (!restoreFocus) return;
            const preferred = returnFocusRef?.current;
            if (preferred && preferred.isConnected) {
              preferred.focus();
              return;
            }
            // A removed opener (its row went away while the dialog was open)
            // is left alone; the caller decides where focus goes then.
            if (opener && opener !== document.body && opener.isConnected) opener.focus();
          }}
          // Falls back to 50%/50% (the box's own center) whenever no real
          // click anchored this open -- keyboard-triggered opens, or the
          // very first render before any pointerdown has ever fired.
          className={`fixed left-1/2 top-1/2 z-50 flex w-[calc(100%-36px)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-md bg-surface shadow-dialog [transform-origin:var(--dialog-origin-x,50%)_var(--dialog-origin-y,50%)] focus:outline-none focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2 data-[state=open]:animate-[dialogIn_var(--duration-base)_var(--ease-out)] data-[state=closed]:animate-[dialogOut_var(--duration-exit)_var(--ease-in)] ${maxWidthClassName} ${maxHeightClassName ?? ''}`}
        >
          <div className="flex flex-none flex-col gap-1 px-5 pt-4 pb-3">
            <div className="flex items-start justify-between gap-3">
              <RadixDialog.Title className="min-w-0 flex-1 text-title">{title}</RadixDialog.Title>
              <RadixDialog.Close asChild>
                <button type="button" aria-label="Close" className="text-ink-3 hover:text-ink-1">
                  <X className="h-4 w-4" />
                </button>
              </RadixDialog.Close>
            </div>
            {description && (
              // asChild + a real <div>, not RadixDialog.Description's own
              // default <p> -- some callers (e.g. NodeDetailDialog) pass
              // description content containing block-level elements
              // (a checkbox label's <div>), which is invalid inside a <p>.
              <RadixDialog.Description asChild>
                <div className="text-sm text-ink-3">{description}</div>
              </RadixDialog.Description>
            )}
          </div>
          {children && (
            <div className={unpadded ? 'flex min-h-0 flex-1 flex-col' : 'flex min-h-0 flex-col gap-3 overflow-y-auto px-5 pt-1 pb-1'}>{children}</div>
          )}
          {footer && <div className="mt-3.5 flex flex-none items-center gap-2.5 border-t border-hairline bg-canvas px-5 py-3.5">{footer}</div>}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
