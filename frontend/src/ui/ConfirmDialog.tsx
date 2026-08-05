import { useEffect, useState, type ReactNode } from 'react';
import { TriangleAlert } from 'lucide-react';
import { Dialog } from './Dialog';
import { Button } from './Button';
import { Checkbox } from './Checkbox';

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
  variant = 'neutral',
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  isConfirming?: boolean;
  variant?: ConfirmDialogVariant;
}): React.ReactElement {
  const [acknowledged, setAcknowledged] = useState(false);

  // Reset the acknowledgement each time the dialog opens -- Radix keeps the
  // Dialog mounted through its close animation rather than unmounting it,
  // so component state would otherwise survive a close/reopen and let a
  // second irreversible write skip the checkbox entirely.
  useEffect(() => {
    if (open) setAcknowledged(false);
  }, [open]);

  const needsAcknowledgement = variant === 'irreversible';
  const buttonVariant = variant === 'destructive' ? 'danger' : variant === 'irreversible' ? 'cta' : 'primary';
  const consequenceCallout =
    variant === 'destructive' && description ? (
      <div className="flex items-start gap-2 rounded-md border border-danger-border bg-danger-soft p-2.5 text-sm text-danger-ink">
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
      title={title}
      // destructive's description moves into its own tinted consequence
      // callout below (rendered in `children`'s slot) instead of the
      // Dialog's plain muted-gray description paragraph -- a permanent
      // delete deserves more visual weight than "this cannot be undone" in
      // the same quiet gray every other dialog's description uses.
      description={variant === 'destructive' ? undefined : description}
      footer={
        <>
          {needsAcknowledgement && (
            <label className="mr-auto flex items-center gap-2 text-sm text-ink-2">
              <Checkbox checked={acknowledged} onCheckedChange={setAcknowledged} ariaLabel="I understand this cannot be undone from req2ado" />
              I understand this cannot be undone from req2ado
            </label>
          )}
          {!needsAcknowledgement && <span className="ml-auto" />}
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant={buttonVariant}
            onClick={onConfirm}
            disabled={isConfirming || (needsAcknowledgement && !acknowledged)}
            loading={isConfirming}
            className={needsAcknowledgement && acknowledged ? 'cta-attention' : undefined}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {body}
    </Dialog>
  );
}
