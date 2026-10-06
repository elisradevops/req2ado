import { InfoTip } from '../../ui/Tooltip';
import type { FinishedItem, LaneState } from '../../store/liveRunStore';
import {
  EXCERPT_EXPLANATION, NO_ACTIVE_WORK_COPY, STALE_WORK_COPY, UNKNOWN_ITEM_COPY, readableTitle,
} from '../../utils/liveCopy';

/** A frame older than this no longer says what the model is doing "now". */
export const STALE_AFTER_MS = 15000;
const MAX_LANES_SHOWN = 3;

const KIND_LABEL: Record<LaneState['kind'], string> = {
  working_on: 'Working on',
  writing: 'Writing',
  ocr_page: 'Reading page',
};

function LaneRow({
  lane,
  stale,
  titleByRef,
}: {
  lane: LaneState;
  stale: boolean;
  titleByRef?: ReadonlyMap<string, string>;
}): React.ReactElement {
  // A frame names its item by id; the document map knows the heading's own words.
  const heading =
    lane.kind === 'ocr_page'
      ? `${KIND_LABEL.ocr_page} ${lane.page ?? '--'}${lane.pages ? ` of ${lane.pages}` : ''}`
      : readableTitle(lane.title, lane.ref, titleByRef) ?? UNKNOWN_ITEM_COPY;
  return (
    <li className='flex flex-col gap-1.5' data-testid='working-on-lane'>
      <div className='flex flex-wrap items-center gap-x-2 gap-y-0.5'>
        <span aria-hidden className='h-2 w-2 flex-none rounded-full bg-live' />
        <span className='text-meta text-ink-3'>{lane.kind === 'ocr_page' ? 'Scanned page' : KIND_LABEL[lane.kind]}</span>
        <span className='min-w-0 truncate text-sm font-semibold text-ink-1' title={heading}>
          {heading}
        </span>
        {lane.itemType && <span className='font-mono text-meta text-ink-3'>{lane.itemType}</span>}
      </div>
      {stale ? (
        <p className='pl-4 text-xs text-ink-3'>{STALE_WORK_COPY}</p>
      ) : (
        lane.excerpt && (
          // Static text: no typed caret and no moving highlight, so there is
          // nothing to switch off for reduced motion. Not announced: it is not
          // inside the page's one live region.
          <blockquote className='ml-4 line-clamp-3 border-l-2 border-live pl-3 text-xs text-ink-2' data-testid='working-on-excerpt'>
            {lane.excerpt}
          </blockquote>
        )
      )}
    </li>
  );
}

export function WorkingOnCard({
  lanes,
  recent,
  now,
  titleByRef,
}: {
  lanes: LaneState[];
  recent: FinishedItem[];
  now: number;
  titleByRef?: ReadonlyMap<string, string>;
}): React.ReactElement {
  const ordered = [...lanes].sort((a, b) => a.lane - b.lane);
  const shown = ordered.slice(0, MAX_LANES_SHOWN);
  const hidden = ordered.length - shown.length;
  // Only items with a readable name are listed; an item known only by its id is left out.
  const finishedNames = recent
    .map((item) => readableTitle(item.title, item.ref, titleByRef))
    .filter((name): name is string => name !== null);
  return (
    <section
      aria-label='What the model is working on'
      className='flex flex-col gap-2.5 rounded-md border border-hairline-strong bg-surface-alt p-3.5'
      data-testid='working-on-card'
    >
      <div className='flex items-center gap-2'>
        <p className='text-sm font-semibold text-ink-1'>
          {ordered.length > 1 ? `${ordered.length} parts in parallel` : 'Now'}
        </p>
        <InfoTip content={EXCERPT_EXPLANATION} label='About the excerpt' />
      </div>
      {shown.length > 0 ? (
        <ul className='flex flex-col gap-3'>
          {shown.map((lane) => (
            <LaneRow key={lane.lane} lane={lane} stale={now - lane.receivedAt > STALE_AFTER_MS} titleByRef={titleByRef} />
          ))}
        </ul>
      ) : (
        <p className='text-xs text-ink-3'>{NO_ACTIVE_WORK_COPY}</p>
      )}
      {hidden > 0 && <p className='text-meta text-ink-3'>and {hidden} more in progress</p>}
      {finishedNames.length > 0 && (
        <p className='truncate border-t border-hairline pt-2 text-xs text-ink-3' data-testid='just-finished'>
          Just finished: <span className='text-ink-2'>{finishedNames.join(' · ')}</span>
        </p>
      )}
    </section>
  );
}
