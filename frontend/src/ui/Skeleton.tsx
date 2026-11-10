import { useEffect, useState } from 'react';
import { cn } from '../lib/cn';

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
      className={cn(
        'block rounded-sm bg-[linear-gradient(90deg,var(--color-hairline)_25%,var(--color-shimmer-highlight)_37%,var(--color-hairline)_63%)] bg-[length:400%_100%]',
        !shown && 'invisible',
        className,
      )}
      // The shimmer starts when the placeholder is drawn, so nothing animates while it is hidden.
      style={shown ? { animation: 'shimmer var(--duration-ambient) var(--ease-linear) infinite' } : undefined}
    />
  );
}
