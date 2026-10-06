import { useMemo } from 'react';
import { diffSideBySide, type DiffToken } from '../../lib/lcsDiff';
import type { ComparePayload } from '../../api/liveTypes';
import { compareSideLabel } from '../../utils/liveCopy';

// The two sides use one highlight for "this word differs": two requirements that
// disagree have no side that is the original. Colour is paired with bold and an
// underline, so it is never the only signal (DESIGN.md section 13). Text is
// rendered as React text, never as HTML.
function Side({
  tokens, label, name, where,
}: {
  tokens: DiffToken[];
  label: string;
  name: string;
  /** The headings above this item, when the outline knows them. */
  where?: string;
}): React.ReactElement {
  return (
    <div role='group' aria-label={name} className='min-w-0 flex-1 rounded-md border border-hairline bg-surface p-3'>
      <div className='mb-1'>
        <p className='truncate text-meta text-ink-3' title={label}>
          {label}
        </p>
        {where && (
          <p className='truncate text-meta text-ink-3' title={where} data-testid='compare-where'>
            In: {where}
          </p>
        )}
      </div>
      <p className='whitespace-pre-wrap break-words text-xs text-ink-1'>
        {tokens.map((token, index) =>
          token.op === 'same' ? (
            <span key={index}>{token.text}</span>
          ) : (
            <mark
              key={index}
              className='rounded-sm bg-warning-soft px-0.5 font-semibold text-warning-ink underline decoration-warning underline-offset-2'
            >
              {token.text}
            </mark>
          ),
        )}
      </p>
    </div>
  );
}

const HEADLINE: Record<ComparePayload['kind'], string> = {
  conflict: 'These two statements may disagree',
  duplicate: 'This proposed item matches an existing work item',
};

export function ComparePair({
  compare,
  titleByRef,
  pathByRef,
}: {
  compare: ComparePayload;
  /** Headings from the document map, to name each side. */
  titleByRef?: ReadonlyMap<string, string>;
  /** The headings above each map item (see lib/outlinePaths), to say where each side sits. */
  pathByRef?: ReadonlyMap<string, string>;
}): React.ReactElement {
  const diff = useMemo(() => diffSideBySide(compare.a.text, compare.b.text), [compare.a.text, compare.b.text]);
  const differing = diff.left.filter((t) => t.op !== 'same').length + diff.right.filter((t) => t.op !== 'same').length;
  const left = compareSideLabel(compare.kind, 'a', compare.a.ref, titleByRef);
  const right = compareSideLabel(compare.kind, 'b', compare.b.ref, titleByRef);
  return (
    <section
      aria-label={HEADLINE[compare.kind]}
      className='flex flex-col gap-2 rounded-md border border-hairline-strong bg-surface-alt p-3.5'
      data-testid='compare-pair'
    >
      <div className='flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1'>
        <p className='text-sm font-semibold text-ink-1'>{HEADLINE[compare.kind]}</p>
        <p className='text-meta text-ink-3'>
          <span className='font-mono tabular-nums text-ink-2'>{Math.round(compare.similarity * 100)}%</span> similar
          {diff.mode === 'words' && differing > 0 && <> · differing words are underlined</>}
          {diff.mode !== 'words' && <> · text is long, so it is shown without highlighting</>}
        </p>
      </div>
      <div className='flex flex-col gap-2 md:flex-row'>
        <Side tokens={diff.left} label={left.label} name={left.name} where={pathByRef?.get(compare.a.ref)} />
        <Side tokens={diff.right} label={right.label} name={right.name} where={pathByRef?.get(compare.b.ref)} />
      </div>
    </section>
  );
}
