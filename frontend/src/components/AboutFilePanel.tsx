import { WorkItemTypeBadge } from './WorkItemTypeBadge';
import { kindLabel } from './FileStudyPanel';
import { Dialog } from '../ui/Dialog';
import type { FileReading } from '../api/jobs';

// "About this file" (the approved mockup, 2026-11-25): everything about how the file was read, in one side panel opened from the new-job page
// and the job header -- how it was read, what a requirement and its ID look like, examples, what was left out and what was fixed
// automatically. The tree preview is not repeated here: it lives in "What it will build".

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  reading: FileReading;
  /** Example requirement codes the study confirmed (the rulebook's grammar), shown as the code shape. */
  codes: string[];
}

function pages(part: FileReading['leftOut'][number]): string {
  if (!part.page) return '';
  return part.pageEnd && part.pageEnd !== part.page ? ` · p${part.page}–${part.pageEnd}` : ` · p${part.page}`;
}

export function AboutFilePanel({ open, onOpenChange, reading, codes }: Props): React.ReactElement {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="About this file" placement="right">
      <div className="flex flex-col gap-4 pb-4 text-sm" data-testid="about-file-panel">
        <section className="flex flex-col gap-1.5">
          <h3 className="text-xs font-semibold text-ink-1">How it was read</h3>
          <ul className="flex list-disc flex-col gap-1 pl-5 text-ink-2">
            <li>Read as {kindLabel(reading.kind)}.</li>
            {reading.coverTitle && (
              <li>
                Its cover names <span dir="auto">“{reading.coverTitle}”</span>.
              </li>
            )}
            {reading.context.length > 0 && (
              <li>
                Kept as the top Epic&apos;s description, because it describes the document: <span dir="auto">{reading.context.join(', ')}</span>.
              </li>
            )}
          </ul>
        </section>
        <section className="flex flex-col gap-1.5">
          <h3 className="text-xs font-semibold text-ink-1">Requirements and IDs</h3>
          <ul className="flex list-disc flex-col gap-1 pl-5 text-ink-2">
            <li>
              {reading.requirements} requirements, {reading.withIds} of them with an ID.
            </li>
            {codes.length > 0 && (
              <li>
                A requirement starts at its code, for example <span className="font-mono">{codes.slice(0, 3).join(', ')}</span>. The code becomes its Customer ID and is
                left out of its description.
              </li>
            )}
            <li>Under each requirement are its text, its lists and Notes, then its trace, set apart by a blank line.</li>
          </ul>
        </section>
        {reading.examples.length > 0 && (
          <section className="flex flex-col gap-1.5">
            <h3 className="text-xs font-semibold text-ink-1">Examples</h3>
            <ul className="flex flex-col gap-1.5">
              {reading.examples.map((example) => (
                <li key={example.customerId} className="flex flex-col">
                  <span className="flex items-center gap-1.5">
                    <WorkItemTypeBadge type="Requirement" iconOnly />
                    <span className="rounded-sm border border-info-border bg-info-soft px-1.5 font-mono text-meta text-info-ink">{example.customerId}</span>
                    <span dir="auto" className="min-w-0 truncate">
                      {example.title}
                    </span>
                  </span>
                  {example.under && (
                    <span dir="auto" className="truncate pl-6 text-xs text-ink-3">
                      ↳ under {example.under}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}
        {reading.leftOut.length > 0 && (
          <section className="flex flex-col gap-1.5">
            <h3 className="text-xs font-semibold text-ink-1">Left out: not requirements</h3>
            <ul className="flex flex-wrap gap-1.5">
              {reading.leftOut.map((part, index) => (
                <li key={`${part.text}-${index}`} dir="auto" className="rounded-full border border-hairline-strong px-2 py-0.5 font-mono text-meta uppercase text-ink-2">
                  {part.text}
                  {pages(part)}
                </li>
              ))}
            </ul>
          </section>
        )}
        <section className="flex flex-col gap-1.5">
          <h3 className="text-xs font-semibold text-ink-1">Fixed automatically</h3>
          <ul className="flex list-disc flex-col gap-1 pl-5 text-ink-2">
            {reading.fixes.map((fix) => (
              <li key={fix.headingId} dir="auto">
                “{fix.from}” → “{fix.to}”
              </li>
            ))}
            <li>Section numbers and codes removed from titles; all-capitals headings in sentence case, with the document&apos;s acronyms kept.</li>
          </ul>
        </section>
      </div>
    </Dialog>
  );
}
