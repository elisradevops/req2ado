import { DescriptionMarkdown } from '../ui/Markdown';
import { LABEL_MICRO } from '../utils/labelMicro';
import type { DescriptionDiff, DiffPart } from '../utils/textDiff';
import { cn } from '../lib/cn';

// The inline "Changes" view of a suggestion (DESIGN.md §11.4.6). Every change is marked by more than colour: a deletion is struck through and an
// insertion underlined, and each carries hidden "deleted" / "inserted" text because most screen readers do not announce ins and del. Marks isolate
// their text direction, so a Latin token inside Hebrew does not reorder the words around it.

const DEL = 'rounded-sm bg-danger-soft px-0.5 text-danger-ink line-through [unicode-bidi:isolate]';
const INS = 'rounded-sm bg-ok-soft px-0.5 text-ok-ink underline underline-offset-2 [unicode-bidi:isolate]';

function Parts({ parts }: { parts: DiffPart[] }): React.ReactElement {
  return (
    <>
      {parts.map((part, index) =>
        part.kind === 'same' ? (
          <span key={index}>{part.text}</span>
        ) : part.kind === 'del' ? (
          <del key={index} className={DEL}>
            <span className="sr-only">deleted: </span>
            {part.text}
          </del>
        ) : (
          <ins key={index} className={INS}>
            <span className="sr-only">inserted: </span>
            {part.text}
          </ins>
        ),
      )}
    </>
  );
}

/** "3 changes: 2 replaced, 1 added." (nothing when there are none). */
export function changeSummary(changes: DescriptionDiff['changes']): string {
  const total = changes.replaced + changes.added + changes.removed;
  if (total === 0) return '';
  const parts = [
    changes.replaced ? `${changes.replaced} replaced` : null,
    changes.added ? `${changes.added} added` : null,
    changes.removed ? `${changes.removed} removed` : null,
  ].filter((part): part is string => part !== null);
  return `${total} ${total === 1 ? 'change' : 'changes'}: ${parts.join(', ')}.`;
}

export function ProposalChanges({ diff }: { diff: DescriptionDiff }): React.ReactElement {
  const summary = changeSummary(diff.changes);
  return (
    <div data-testid="proposal-changes" className="flex min-w-0 flex-col gap-1.5">
      {diff.blocks.map((block, index) => {
        switch (block.kind) {
          case 'same':
            return (
              <p key={index} dir="auto" className="text-sm text-ink-1">
                {block.text}
              </p>
            );
          case 'changed':
            return (
              <p key={index} dir="auto" className="text-sm leading-relaxed text-ink-1">
                <Parts parts={block.parts} />
              </p>
            );
          case 'added':
            return (
              <p key={index} dir="auto" className="text-sm text-ink-1">
                <ins className={INS}>
                  <span className="sr-only">inserted: </span>
                  {block.text}
                </ins>
              </p>
            );
          case 'removed':
            return (
              <p key={index} dir="auto" className="text-sm text-ink-1">
                <del className={DEL}>
                  <span className="sr-only">deleted: </span>
                  {block.text}
                </del>
              </p>
            );
          case 'table-same':
            return (
              <div key={index} className="overflow-x-auto text-sm">
                <DescriptionMarkdown>{block.html}</DescriptionMarkdown>
              </div>
            );
          case 'table-cells':
            return (
              <div key={index} className="overflow-x-auto">
                <table className="w-full border-collapse text-sm">
                  <tbody>
                    {block.rows.map((row, r) => (
                      <tr key={r}>
                        {row.map((cell, c) => {
                          const Cell = r === 0 ? 'th' : 'td';
                          return (
                            <Cell key={c} dir="auto" className="border border-hairline px-2 py-1 text-start align-top">
                              <Parts parts={cell} />
                            </Cell>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case 'table-replaced':
            return (
              <div key={index} className="flex flex-col gap-2 rounded-sm border border-hairline p-2">
                <p className="text-xs text-ink-3">The table changed shape, so both versions are shown.</p>
                {block.before && (
                  <div className="overflow-x-auto">
                    <p className={cn(LABEL_MICRO, 'mb-1 text-danger-ink')}>Table before</p>
                    <DescriptionMarkdown>{block.before}</DescriptionMarkdown>
                  </div>
                )}
                {block.after && (
                  <div className="overflow-x-auto">
                    <p className={cn(LABEL_MICRO, 'mb-1 text-ok-ink')}>Table after</p>
                    <DescriptionMarkdown>{block.after}</DescriptionMarkdown>
                  </div>
                )}
              </div>
            );
        }
      })}
      <p className="text-xs text-ink-3">
        {summary ? `${summary} Marked by underline and strikethrough as well as colour.` : 'The text is unchanged.'}
      </p>
    </div>
  );
}
