import { createContext, forwardRef, useContext, useEffect, useMemo, useRef, type HTMLAttributes } from 'react';
import { FixedSizeList, type ListChildComponentProps } from 'react-window';
import { Check, Circle } from 'lucide-react';
import { cn } from '../../lib/cn';
import type { MapItem } from '../../api/liveTypes';
import { formatCount, OUTLINE_TRUNCATED_COPY } from '../../utils/liveCopy';

export const ROW_HEIGHT = 28;
export const MAX_OUTLINE_HEIGHT = 224;
const MAX_INDENT_LEVELS = 5;

type RowState = 'done' | 'working' | 'pending';

interface RowData {
  items: MapItem[];
  states: RowState[];
}

function Row({ index, style, data }: ListChildComponentProps<RowData>): React.ReactElement {
  const item = data.items[index];
  const state = data.states[index];
  return (
    <li
      style={{ ...style, paddingLeft: 8 + Math.min(item.depth, MAX_INDENT_LEVELS) * 12 }}
      className={cn('flex items-center gap-2 pr-2 text-xs', state === 'working' && 'bg-surface-sunken')}
      aria-current={state === 'working' ? 'step' : undefined}
    >
      {/* State is a glyph and a word for assistive tech, never colour alone. */}
      {state === 'done' ? (
        <Check aria-hidden className='h-3.5 w-3.5 flex-none text-ok' />
      ) : state === 'working' ? (
        <span aria-hidden className='h-2.5 w-2.5 flex-none rounded-full bg-live' />
      ) : (
        <Circle aria-hidden className='h-3.5 w-3.5 flex-none text-ink-3' />
      )}
      <span className='sr-only'>{state === 'done' ? 'Written: ' : state === 'working' ? 'In progress: ' : 'Waiting: '}</span>
      <span className={cn('min-w-0 flex-1 truncate', state === 'pending' ? 'text-ink-3' : 'text-ink-1')} title={item.title}>
        {item.title}
      </span>
      <span className='flex-none font-mono text-meta tabular-nums text-ink-3'>{formatCount(item.words)}</span>
    </li>
  );
}

// The scrolling element react-window renders. A region that scrolls must be
// reachable by keyboard (WCAG 2.1.1, found by the browser matrix's axe scan), so
// it is the outline's one tab stop: focus it and the arrow keys and Page Up/Down
// scroll it. Its name carries the count. react-window only passes a few props to
// this element, so the name comes in through context.
const OutlineLabel = createContext('Document outline');
const ScrollRegion = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function ScrollRegion(props, ref) {
  const label = useContext(OutlineLabel);
  return <div {...props} ref={ref} role='region' aria-label={label} tabIndex={0} />;
});

// A read-only outline of the document with what is finished, what the model is
// on now, and what is waiting. Virtualised: a 5,000-item map costs the same as a
// 20-item one. Its rows are not interactive; the scrolling region itself is
// focusable so the keyboard can scroll it, and it is the only tab stop here.
export function DocumentOutline({
  items,
  doneRefs,
  workingRefs,
  truncated,
}: {
  items: MapItem[];
  doneRefs: Record<string, unknown>;
  workingRefs: ReadonlySet<string>;
  truncated: boolean;
}): React.ReactElement {
  const states = useMemo<RowState[]>(
    () => items.map((item) => (doneRefs[item.ref] ? 'done' : workingRefs.has(item.ref) ? 'working' : 'pending')),
    [items, doneRefs, workingRefs],
  );
  const data = useMemo(() => ({ items, states }), [items, states]);
  const height = Math.min(MAX_OUTLINE_HEIGHT, Math.max(ROW_HEIGHT, items.length * ROW_HEIGHT));
  const listRef = useRef<FixedSizeList<RowData>>(null);
  const userScrolled = useRef(false);

  // Keep the row being worked on in view, unless the reader has scrolled away.
  const workingIndex = states.indexOf('working');
  useEffect(() => {
    if (workingIndex >= 0 && !userScrolled.current) listRef.current?.scrollToItem(workingIndex, 'smart');
  }, [workingIndex]);

  const doneCount = states.filter((state) => state === 'done').length;
  return (
    <div data-testid='document-outline'>
      <OutlineLabel.Provider value={`Document outline, ${doneCount} of ${items.length} written`}>
        <FixedSizeList
          outerElementType={ScrollRegion}
          ref={listRef}
          height={height}
          width='100%'
          itemCount={items.length}
          itemSize={ROW_HEIGHT}
          itemData={data}
          itemKey={(index, itemData) => itemData.items[index].ref}
          innerElementType='ul'
          overscanCount={6}
          onScroll={({ scrollUpdateWasRequested }) => {
            if (!scrollUpdateWasRequested) userScrolled.current = true;
          }}
          className='rounded-md border border-hairline bg-surface'
        >
          {Row}
        </FixedSizeList>
      </OutlineLabel.Provider>
      {truncated && <p className='mt-1 text-meta text-ink-3'>{OUTLINE_TRUNCATED_COPY}</p>}
    </div>
  );
}
