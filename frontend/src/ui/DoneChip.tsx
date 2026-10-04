import { useLayoutEffect } from 'react';
import { useAnimate } from 'motion/react-mini';
import { Check } from 'lucide-react';
import { cn } from '../lib/cn';

// "Done" marker that pops in when something is completed -- the one place a
// reviewer should feel a task close. A spring (not a fade) so it reads as a
// confirmation. Uses motion's mini build (the Web Animations API, ~3 KB)
// rather than the full React components, which cost ~28 KB for this alone.
// Skipped for reduced-motion users and where the Web Animations API is
// missing (jsdom): the chip then simply appears.
export function DoneChip({ className }: { className?: string }): React.ReactElement {
  const [scope, animate] = useAnimate<HTMLSpanElement>();
  // Layout effect, so the starting frame is applied before first paint
  // instead of flashing at full size first.
  useLayoutEffect(() => {
    const element = scope.current;
    if (!element || typeof element.animate !== 'function') return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    void animate(element, { scale: [0.6, 1], opacity: [0, 1] }, { type: 'spring', stiffness: 520, damping: 24 });
  }, [animate, scope]);

  return (
    <span
      ref={scope}
      className={cn(
        'inline-flex items-center gap-1 rounded-full border border-ok-border bg-ok-soft px-1.5 align-[1px] text-micro font-semibold text-ok-ink',
        className,
      )}
    >
      <Check className="h-2.5 w-2.5" />
      Done
    </span>
  );
}
