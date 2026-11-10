import type { ComponentType } from 'react';
import { cn } from '../lib/cn';
import { Spinner } from './Spinner';
import { Tooltip } from './Tooltip';

/**
 * A toolbar button that is only a glyph. The label is its accessible name and its tooltip, so it is never an unlabelled control. 32px at desktop
 * widths; 44px below md, where it is touched, not pointed at.
 */
export function IconButton({
  label,
  icon: Icon,
  onClick,
  disabled,
  loading,
  tone = 'default',
  compactLabel,
}: {
  label: string;
  icon: ComponentType<{ className?: string }>;
  onClick: () => void;
  disabled?: boolean;
  loading?: boolean;
  // `danger` marks a destructive action by colour as well as by where it is placed.
  tone?: 'default' | 'danger';
  // Short visible text beside the glyph below md, where there is no hover to show the tooltip. It must be contained in `label` (the accessible
  // name), e.g. "Download" for "Download summary".
  compactLabel?: string;
}): React.ReactElement {
  return (
    // The tooltip hangs off a wrapper, not the button: a disabled button receives no pointer events, so a tooltip on it would never show.
    <Tooltip content={label}>
      <span className="inline-flex">
        <button
          type="button"
          aria-label={label}
          aria-busy={loading || undefined}
          disabled={disabled || loading}
          onClick={onClick}
          className={cn(
            'grid h-8 w-8 place-items-center rounded-sm transition-colors duration-instant max-md:h-11 max-md:w-auto max-md:min-w-11 max-md:px-2.5',
            compactLabel && 'max-md:flex max-md:items-center max-md:gap-1.5',
            tone === 'danger' ? 'text-danger-ink hover:bg-danger-soft' : 'text-ink-2 hover:bg-canvas hover:text-ink-1',
            (disabled || loading) && 'cursor-not-allowed text-ink-3 hover:bg-transparent hover:text-ink-3',
          )}
        >
          {loading ? <Spinner className="h-4 w-4" /> : <Icon className="h-4 w-4" />}
          {compactLabel && <span className="hidden text-xs font-medium max-md:inline">{compactLabel}</span>}
        </button>
      </span>
    </Tooltip>
  );
}
