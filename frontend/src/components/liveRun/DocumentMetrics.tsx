import { Chip } from '../../ui/Chip';
import type { DocStats } from '../../api/liveTypes';
import { formatCount } from '../../utils/liveCopy';

const CHIP = 'border border-hairline-strong font-mono text-meta font-normal tabular-nums';

// What the run is working through, counted once at parse time. A figure the
// document does not have is not shown as 0 (DESIGN.md section 16.23: unknown is
// `--`, absent is absent).
export function DocumentMetrics({
  stats,
  finished,
  total,
}: {
  stats: DocStats;
  /** Outline items the run has finished so far. */
  finished: number;
  /** Outline items the document has; 0 when the outline is not available. */
  total: number;
}): React.ReactElement {
  return (
    <div className='flex flex-wrap items-center gap-2' data-testid='document-metrics'>
      <Chip bg='var(--color-surface)' color='var(--color-ink-2)' className={CHIP}>
        {formatCount(stats.words)} {stats.words === 1 ? 'word' : 'words'}
      </Chip>
      {stats.headings > 0 && (
        <Chip bg='var(--color-surface)' color='var(--color-ink-2)' className={CHIP}>
          {formatCount(stats.headings)} {stats.headings === 1 ? 'heading' : 'headings'}
        </Chip>
      )}
      {stats.tables > 0 && (
        <Chip bg='var(--color-surface)' color='var(--color-ink-2)' className={CHIP}>
          {formatCount(stats.tables)} {stats.tables === 1 ? 'table' : 'tables'}
          {stats.tableRows > 0 ? ` (${formatCount(stats.tableRows)} rows)` : ''}
        </Chip>
      )}
      {stats.figures > 0 && (
        <Chip bg='var(--color-surface)' color='var(--color-ink-2)' className={CHIP}>
          {formatCount(stats.figures)} {stats.figures === 1 ? 'figure' : 'figures'}
        </Chip>
      )}
      {stats.pages != null && (
        <Chip bg='var(--color-surface)' color='var(--color-ink-2)' className={CHIP}>
          {formatCount(stats.pages)} {stats.pages === 1 ? 'page' : 'pages'}
        </Chip>
      )}
      {total > 0 && (
        <span className='text-xs text-ink-3'>
          <span className='font-mono tabular-nums text-ink-2'>
            {formatCount(Math.min(finished, total))} of {formatCount(total)}
          </span>{' '}
          outline items written
        </span>
      )}
    </div>
  );
}
