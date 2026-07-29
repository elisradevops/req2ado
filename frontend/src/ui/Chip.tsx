import type { HTMLAttributes } from 'react';
import { cn } from '../lib/cn';

/**
 * Generic colored pill. Prefer a real hex `color`/`bg` pair for data-driven
 * colors (tag/issue/status maps) over adding new Tailwind color tokens for
 * every possible value — those maps are open-ended and keyed by backend
 * strings, unlike the fixed design-system palette in index.css.
 */
export function Chip({
  className,
  style,
  color,
  bg,
  ...props
}: HTMLAttributes<HTMLSpanElement> & { color?: string; bg?: string }): React.ReactElement {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold whitespace-nowrap',
        className,
      )}
      style={{ color, backgroundColor: bg, ...style }}
      {...props}
    />
  );
}
