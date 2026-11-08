import { useRef, useState } from 'react';

// One reviewer step that U (or the toast's Undo) can run backwards.
export interface QueueUndo {
  label: string;
  run: () => Promise<boolean>;
}

// The last-undo slot and the live-region text of the review flow. Takes no inputs, so any review
// action (a queue accept, an exclude, a bulk approve) can share it.
export function useUndoAnnouncement() {
  // Runs the reviewer's last action backwards (U). Null once used, or before any.
  const lastUndoRef = useRef<QueueUndo | null>(null);
  // Mirrors "there is something to undo", so the U hint only shows when it would do something.
  const [hasUndo, setHasUndo] = useState(false);
  function setLastUndo(undo: QueueUndo | null): void {
    lastUndoRef.current = undo;
    setHasUndo(undo !== null);
  }
  // The toast's own Undo ran this step already, so U must not run it again.
  function clearLastUndoIf(undo: QueueUndo | undefined): void {
    if (undo && lastUndoRef.current === undo) setLastUndo(null);
  }
  const [announcement, setAnnouncement] = useState('');
  // A live region only speaks when its text changes, so an identical message (a second "Still
  // saving") alternates an invisible trailing character. Spoken text is unchanged.
  const announceFlipRef = useRef(false);
  function announceAgain(message: string): void {
    announceFlipRef.current = !announceFlipRef.current;
    setAnnouncement(announceFlipRef.current ? `${message}​` : message);
  }
  return { lastUndoRef, hasUndo, setLastUndo, clearLastUndoIf, announcement, setAnnouncement, announceAgain };
}
