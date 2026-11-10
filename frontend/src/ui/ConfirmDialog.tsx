import { useEffect, useId, useState, type ReactNode } from 'react';
import { TriangleAlert } from 'lucide-react';
import { Dialog } from './Dialog';
import { Button } from './Button';
import { Checkbox } from './Checkbox';
import { cn } from '../lib/cn';

// The three named ConfirmDialog templates (DESIGN.md Track B, phase B12) --
// every confirmation in the app is exactly one of these, not an ad hoc
// combination of booleans (the previous `destructive?`/`irreversible?` pair
// let a caller omit both, which silently fell through to the CTA/signal
// button variant -- a confirmed real §15.7 violation: three "Resubmit"
// dialogs across JobsList.tsx/JobDetail.tsx rendered signal-yellow, the
// color reserved strictly for the one truly irreversible action).
export type ConfirmDialogVariant = 'neutral' | 'destructive' | 'irreversible';

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  confirmLabel,
  onConfirm,
  isConfirming,
  confirmDisabled,
  confirmDisabledReason,
  variant = 'neutral',
  cancelVariant = 'ghost',
  restoreFocus,
  returnFocusRef,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  isConfirming?: boolean;
  // The caller knows the action would do nothing (for example a write of zero items).
  confirmDisabled?: boolean;
  // Said to assistive technology as the button's description while it is disabled by `confirmDisabled`.
  confirmDisabledReason?: string;
  variant?: ConfirmDialogVariant;
  // 'outline' gives Cancel a visible border, for a dialog whose buttons would otherwise read as plain text.
  cancelVariant?: 'ghost' | 'outline';
  // Forwarded to Dialog: false when a button in the body takes the reader somewhere and focus must not jump back to the opener.
  restoreFocus?: boolean;
  returnFocusRef?: React.RefObject<HTMLElement | null>;
}): React.ReactElement {
  const [acknowledged, setAcknowledged] = useState(false);
  const reasonId = useId();
  const hintId = useId();
  const consequenceId = useId();

  // Reset the acknowledgement each time the dialog opens -- Radix keeps the
  // Dialog mounted through its close animation rather than unmounting it,
  // so component state would otherwise survive a close/reopen and let a
  // second irreversible write skip the checkbox entirely.
  useEffect(() => {
    if (open) setAcknowledged(false);
  }, [open]);

  const needsAcknowledgement = variant === 'irreversible';
  // Said only while the box is the one thing keeping the button off (not while checking, confirming or with nothing to write).
  const showTickHint = needsAcknowledgement && !acknowledged && !isConfirming && !confirmDisabled;
  const reasonShown = !!confirmDisabled && !!confirmDisabledReason;
  const describedBy = [reasonShown ? reasonId : null, showTickHint ? hintId : null].filter(Boolean).join(' ') || undefined;
  const buttonVariant = variant === 'destructive' ? 'danger' : variant === 'irreversible' ? 'cta' : 'primary';
  const consequenceCallout =
    variant === 'destructive' && description ? (
      <div id={consequenceId} className="flex items-start gap-2 rounded-md border border-danger-border bg-danger-soft p-2.5 text-sm text-danger-ink">
        <TriangleAlert className="mt-0.5 h-4 w-4 flex-none" />
        <div>{description}</div>
      </div>
    ) : null;
  // Dialog only renders its children wrapper (with its own padding) when
  // this is non-empty -- passing an array containing e.g. `[null, undefined]`
  // would itself be truthy and add a blank padded gap to every dialog that
  // has neither a callout nor caller-supplied children (the common case:
  // Reject/Cancel/Resubmit, all plain description-only dialogs).
  const body = consequenceCallout || children ? (
    <>
      {consequenceCallout}
      {children}
    </>
  ) : undefined;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      restoreFocus={restoreFocus}
      returnFocusRef={returnFocusRef}
      // On a short screen the body scrolls and the buttons stay in view.
      maxHeightClassName="max-h-[calc(100dvh-2rem)]"
      title={title}
      describedById={consequenceCallout ? consequenceId : undefined}
      // destructive's description moves into its own tinted consequence
      // callout below (rendered in `children`'s slot) instead of the
      // Dialog's plain muted-gray description paragraph -- a permanent
      // delete deserves more visual weight than "this cannot be undone" in
      // the same quiet gray every other dialog's description uses.
      description={variant === 'destructive' ? undefined : description}
      footer={
        // Wraps: a long confirm label (the write names its count and project) must not squeeze the acknowledgement or run past the dialog.
        <div className="flex w-full flex-wrap items-center justify-end gap-2.5">
          {needsAcknowledgement && (
            <label className="flex w-full items-center gap-2 text-sm text-ink-2">
              <Checkbox checked={acknowledged} onCheckedChange={setAcknowledged} ariaLabel="I understand this cannot be undone from req2ado" />
              I understand this cannot be undone from req2ado
            </label>
          )}
          {/* An irreversible dialog opens on Cancel, so Enter or Space on opening never writes or leaves through content in the body. */}
          <Button variant={cancelVariant} autoFocus={needsAcknowledgement} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant={buttonVariant}
            onClick={onConfirm}
            disabled={isConfirming || confirmDisabled || (needsAcknowledgement && !acknowledged)}
            loading={isConfirming}
            aria-describedby={describedBy}
            className={cn('max-w-full', needsAcknowledgement && acknowledged && 'cta-attention')}
          >
            {/* A long project name truncates; the count comes first, and the accessible name stays the full text. */}
            <span className="block max-w-full truncate" title={confirmLabel}>
              {confirmLabel}
            </span>
          </Button>
          {showTickHint && (
            <span id={hintId} className="min-w-0 basis-full text-xs text-ink-3 [overflow-wrap:anywhere] sm:basis-auto sm:text-end">
              Tick the box above to enable this button.
            </span>
          )}
          {confirmDisabled && confirmDisabledReason && (
            <span id={reasonId} className="sr-only">
              {confirmDisabledReason}
            </span>
          )}
        </div>
      }
    >
      {body}
    </Dialog>
  );
}
