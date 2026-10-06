import { useEffect, useState } from 'react';
import { Info, TriangleAlert } from 'lucide-react';
import type { Notice } from '../../api/liveTypes';
import { noticeCopy } from '../../utils/liveCopy';

const OPENED_KEY = 'req2ado.notices.opened.';

function wasOpened(key: string): boolean {
  try {
    return sessionStorage.getItem(OPENED_KEY + key) === '1';
  } catch {
    return false;
  }
}

function rememberOpened(key: string): void {
  try {
    sessionStorage.setItem(OPENED_KEY + key, '1');
  } catch {
    // Remembering is a convenience; the section simply opens again next time.
  }
}

// What changed the run: limits the model hit and adjustments the run made. One
// disclosure, collapsed unless something needs attention. The first warning for a
// job opens it once (and says so through the page's polite status region); after
// the reader closes it, it stays closed. Every row pairs an icon with a word, so
// colour is never the only signal (DESIGN.md section 13). Renders nothing when
// there is nothing to say.
export function RunNotices({
  notices, heading, storageKey, titleByRef,
}: {
  notices: Notice[];
  heading: string;
  /** Scopes the "already opened" memory, for example `${jobId}.live`. */
  storageKey: string;
  titleByRef?: ReadonlyMap<string, string>;
}): React.ReactElement | null {
  const warnings = notices.filter((n) => n.severity === 'warning').length;
  const [open, setOpen] = useState(() => warnings > 0 && !wasOpened(storageKey));

  useEffect(() => {
    if (warnings > 0 && !wasOpened(storageKey)) {
      rememberOpened(storageKey);
      setOpen(true);
    }
  }, [warnings, storageKey]);

  if (notices.length === 0) return null;

  const summary = warnings > 0 ? `${notices.length} ${notices.length === 1 ? 'item' : 'items'}, ${warnings} to check` : `${notices.length} ${notices.length === 1 ? 'item' : 'items'}`;

  return (
    <details
      open={open}
      onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}
      className='rounded-md border border-hairline bg-surface-alt text-xs'
      data-testid='run-notices'
    >
      <summary className='flex cursor-pointer items-center gap-2 px-3 py-2 font-medium text-ink-1'>
        <span>{heading}</span>
        <span className='font-normal text-ink-3'>{summary}</span>
      </summary>
      <ul className='flex flex-col gap-2 border-t border-hairline px-3 py-2'>
        {notices.map((notice) => {
          const copy = noticeCopy(notice, titleByRef);
          const warn = notice.severity === 'warning';
          const Icon = warn ? TriangleAlert : Info;
          return (
            <li key={notice.kind} className='flex gap-2' data-testid={`notice-${notice.kind}`}>
              <Icon aria-hidden className={`mt-0.5 h-3.5 w-3.5 flex-none ${warn ? 'text-warning-ink' : 'text-info-ink'}`} />
              <div className='min-w-0'>
                <p className='font-medium text-ink-1'>
                  <span className={warn ? 'text-warning-ink' : 'text-info-ink'}>{warn ? 'Check: ' : 'Note: '}</span>
                  {copy.title}
                </p>
                <p className='text-ink-2'>{copy.detail}</p>
              </div>
            </li>
          );
        })}
      </ul>
    </details>
  );
}
