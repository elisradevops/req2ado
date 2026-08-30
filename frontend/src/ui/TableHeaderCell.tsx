import type { ReactNode } from 'react';
import { cn } from '../lib/cn';
import { LABEL_MICRO } from '../utils/labelMicro';

// The `<th>` recipe (padding + the shared LABEL_MICRO look + alignment) was
// copy-pasted per column across KbFileList/BatchStatus/JobsList with three
// slightly different paddings and no shared source -- this is that source.
// `className` overrides win via cn's tailwind-merge (e.g. a caller's own
// `py-2.5`/`py-1` replaces this component's default `py-2`).
export function TableHeaderCell({
  children,
  align = 'left',
  sticky = false,
  className,
}: {
  children?: ReactNode;
  align?: 'left' | 'right';
  sticky?: boolean;
  className?: string;
}): React.ReactElement {
  return (
    <th className={cn('px-3.5 py-2', LABEL_MICRO, align === 'right' ? 'text-right' : 'text-left', sticky && 'sticky top-0 z-10 bg-surface-sunken', className)}>
      {children}
    </th>
  );
}
