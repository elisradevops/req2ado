import { useId, useState } from 'react';
import { Check, Sparkles } from 'lucide-react';
import { Button } from '../ui/Button';
import { LABEL_MICRO } from '../utils/labelMicro';
import { cn } from '../lib/cn';
import type { DryRunDiffEntry } from './DiffTree';

// A section the SURVEY run generated for a requirement (proposed acceptance criteria, or a "Needs author input" note), held apart from the
// description: it reaches Azure DevOps only when the reviewer accepts it (criteria only). Its HTML is read into plain text here and rendered
// as React text, never as markup, so nothing in it can inject elements.

// The section's blocks in document order: a list of items, a label ("Assumptions", set in italics), or a paragraph of text.
export type ProposalBlock = { kind: 'list'; items: string[] } | { kind: 'label'; text: string } | { kind: 'text'; text: string };

export interface ParsedProposal {
  title: string;
  blocks: ProposalBlock[];
}

export function parseProposalHtml(html: string): ParsedProposal {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const clean = (text: string | null | undefined): string => (text ?? '').replace(/\s+/g, ' ').trim();
  const title = clean(doc.querySelector('b, strong')?.textContent);
  const root = doc.body.querySelector('div') ?? doc.body;
  const blocks: ProposalBlock[] = [];
  for (const child of Array.from(root.children)) {
    const tag = child.tagName.toLowerCase();
    if (tag === 'ul' || tag === 'ol') {
      const items = Array.from(child.querySelectorAll('li')).map((li) => clean(li.textContent)).filter(Boolean);
      if (items.length > 0) blocks.push({ kind: 'list', items });
    } else if (tag === 'p') {
      if (child.querySelector('b, strong')) continue; // the title, shown as the heading
      const text = clean(child.textContent);
      if (text) blocks.push({ kind: child.querySelector('i, em') ? 'label' : 'text', text });
    }
  }
  return { title, blocks };
}

export function ProposalCard({
  entry,
  canAccept,
  lockedNote,
  onSetAccepted,
}: {
  entry: DryRunDiffEntry;
  canAccept: boolean;
  // Why the proposal cannot be accepted or withdrawn right now (reuse, excluded, review closed); shown instead of the accept copy.
  lockedNote?: string;
  onSetAccepted?: (localId: string, accepted: boolean) => Promise<void> | void;
}): React.ReactElement | null {
  const [pending, setPending] = useState(false);
  const headingId = useId();
  const proposal = entry.proposal;
  if (!proposal) return null;
  const parsed = parseProposalHtml(proposal.html);
  const isCriteria = proposal.kind === 'criteria';
  const readable = parsed.blocks.some((block) => block.kind === 'list');
  const accepted = isCriteria && entry.proposalAccepted === true;
  const interactive = canAccept && (readable || accepted); // an unreadable proposal is never offered for acceptance, but a stored acceptance can be withdrawn

  async function set(next: boolean): Promise<void> {
    if (!onSetAccepted || pending) return;
    setPending(true);
    try {
      await onSetAccepted(entry.localId, next);
    } catch {
      // The caller already shows the failure; the card just keeps the server's state.
    } finally {
      setPending(false);
    }
  }

  let status: string;
  if (!readable && !accepted) status = 'Could not read this proposal, so it will not be written to Azure DevOps.';
  else if (!canAccept) status = lockedNote ?? 'Not written to Azure DevOps.';
  else if (accepted) status = 'Accepted — will be written to Azure DevOps with this item.';
  else status = 'Not written to Azure DevOps unless you accept it.';

  return (
    <section
      aria-labelledby={headingId}
      className={cn('flex max-w-[68ch] flex-col gap-2 rounded-sm border p-3', accepted ? 'border-accent bg-accent-soft' : 'border-hairline bg-surface-alt')}
    >
      <div className="flex items-center gap-1.5">
        <Sparkles className="h-3.5 w-3.5 flex-none text-ink-3" aria-hidden="true" />
        <h3 id={headingId} className={cn(LABEL_MICRO, 'text-ink-2')}>
          {parsed.title || (isCriteria ? 'Proposed acceptance criteria' : 'Needs author input')}
        </h3>
      </div>
      {parsed.blocks.map((block, index) =>
        block.kind === 'list' ? (
          <ul key={index} className="flex list-disc flex-col gap-1 pl-5 text-sm leading-relaxed text-ink-1 [overflow-wrap:anywhere]">
            {block.items.map((item, itemIndex) => (
              <li key={itemIndex}>{item}</li>
            ))}
          </ul>
        ) : (
          <p
            key={index}
            className={cn('text-sm leading-relaxed [overflow-wrap:anywhere]', block.kind === 'label' ? 'font-medium text-ink-2' : 'text-ink-2')}
          >
            {block.text}
          </p>
        ),
      )}
      {isCriteria && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p role="status" className="text-xs text-ink-3">
            {status}
          </p>
          {interactive && (
            // One button for both states, never disabled while saving: swapping or disabling it would drop keyboard focus.
            <Button
              variant={accepted ? 'ghost' : 'outline'}
              size="sm"
              aria-busy={pending}
              onClick={() => void set(!accepted)}
            >
              {pending ? 'Saving…' : accepted ? 'Undo' : (
                <>
                  <Check className="h-3.5 w-3.5" aria-hidden="true" /> Accept criteria
                </>
              )}
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
