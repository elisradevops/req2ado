import { Alert } from '../ui/Alert';
import { ConfirmDialog } from '../ui/ConfirmDialog';

// Asked when the files being added come from a different SharePoint library than the ones already in the knowledge base. A
// knowledge base keeps one library (files of a library nobody searches only take up storage), so going ahead removes the old
// files. Nothing is removed until the user confirms here.

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // Files recorded as coming from another library.
  otherDrive: number;
  // Files added before the library was recorded.
  unknownDrive: number;
  onConfirm: () => void;
  // The removal is running.
  isWorking?: boolean;
  // Why the last removal did not finish, in words; the dialog stays open so the user can try again.
  errorMessage?: string | null;
}

const files = (n: number): string => `${n} ${n === 1 ? 'file' : 'files'}`;

export function KbSwitchLibraryDialog({ open, onOpenChange, otherDrive, unknownDrive, onConfirm, isWorking = false, errorMessage = null }: Props): React.ReactElement {
  const total = otherDrive + unknownDrive;
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      variant="destructive"
      title="Switch to this library?"
      description={
        <div className="flex flex-col gap-2">
          {otherDrive > 0 && <p>Your knowledge base holds {files(otherDrive)} from a different SharePoint library.</p>}
          {unknownDrive > 0 && (
            <p>
              {files(unknownDrive)} {unknownDrive === 1 ? 'was' : 'were'} added before the library was tracked, so there is no telling whether {unknownDrive === 1 ? 'it belongs' : 'they belong'} here.
            </p>
          )}
          <p>A knowledge base keeps one library, so adding from this one removes {total === 1 ? 'that file' : 'those files'} and {total === 1 ? 'its' : 'their'} searchable text. Add {total === 1 ? 'it' : 'them'} again from here if you still need {total === 1 ? 'it' : 'them'}.</p>
        </div>
      }
      confirmLabel={`Remove ${files(total)} and continue`}
      onConfirm={onConfirm}
      isConfirming={isWorking}
      cancelVariant="outline"
    >
      {errorMessage && <Alert severity="error">{errorMessage}</Alert>}
    </ConfirmDialog>
  );
}
