import { useEffect, useState } from 'react';
import { cn } from '../lib/cn';
import { ARRIVE } from './motion';

// How long a wait must last before a loading placeholder is drawn (DESIGN.md section 8.3). Under about a second a
// placeholder only flashes and makes the page feel slower than it is (GitHub Primer loading pattern; NN/g skeleton
// screens), so a fast load shows nothing. One constant, for every skeleton in the app.
export const SKELETON_DELAY_MS = 1000;

export function Skeleton({ className }: { className?: string }): React.ReactElement {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setShown(true), SKELETON_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);
  return (
    <span
      // `invisible` keeps the placeholder's size in the layout, so the page does not jump when it appears or when the content replaces it.
      // A static block, no shimmer loop (research #7): a placeholder is not a liveness indicator, and the page's "Loading…" status text
      // already says the wait is real.
      className={cn('block rounded-sm bg-hairline', !shown && 'invisible', className)}
    />
  );
}

// Research #7 (DESIGN.md §8.3): the content that replaces a placeholder cross-fades in, but only when the placeholder was actually drawn
// (the load outlasted SKELETON_DELAY_MS). A fast load shows neither the placeholder nor a fade. Returns the entrance class for the
// content, or undefined. The kill-switch clamps the fade under reduced motion; the swap itself is the text equivalent.
export function useSkeletonCrossfade(loading: boolean): string | undefined {
  const [drawn, setDrawn] = useState(false);
  useEffect(() => {
    if (!loading) return;
    const timer = setTimeout(() => setDrawn(true), SKELETON_DELAY_MS);
    return () => clearTimeout(timer);
  }, [loading]);
  return !loading && drawn ? ARRIVE.fade : undefined;
}
