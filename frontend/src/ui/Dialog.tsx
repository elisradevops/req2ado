import type { ReactNode } from 'react';
import { Dialog as RadixDialog } from 'radix-ui';
import { X } from 'lucide-react';

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
}): React.ReactElement {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-40 bg-[#0B1220]/44 data-[state=open]:animate-[fadeIn_150ms_ease-out] data-[state=closed]:animate-[fadeOut_130ms_ease-in]" />
        <RadixDialog.Content
          className={`fixed left-1/2 top-1/2 z-50 flex w-[calc(100%-36px)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-md bg-surface shadow-dialog focus:outline-none data-[state=open]:animate-[dialogIn_170ms_ease-out] data-[state=closed]:animate-[dialogOut_130ms_ease-in] ${maxWidthClassName} ${maxHeightClassName ?? ''}`}
        >
          <div className="flex flex-none flex-col gap-1 px-5 pt-4 pb-3">
            <div className="flex items-start justify-between gap-3">
              <RadixDialog.Title className="text-[17px] font-semibold tracking-tight">{title}</RadixDialog.Title>
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
            <div className={unpadded ? 'flex min-h-0 flex-1 flex-col' : 'flex flex-col gap-3 px-5 pb-1'}>{children}</div>
          )}
          {footer && <div className="mt-3.5 flex flex-none items-center gap-2.5 border-t border-hairline bg-canvas px-5 py-3.5">{footer}</div>}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
