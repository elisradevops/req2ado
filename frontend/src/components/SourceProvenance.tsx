import { FileText } from 'lucide-react';
import { basenameOf, sourceRefRows, type SourceRefLike } from '../utils/sourceRef';
import { KbCitationChips, type KbCitation } from './KbCitationChips';

// The "Sources" section's actual content -- file identity, where in that
// file, why it was scored the way it was, and which KB docs informed the
// score. Pulled out of NodeDetailPanel.tsx (which owns the surrounding
// gating: whether to show a "Sources" section at all depends on jobMode/
// entry.action, neither of which this component needs) because this block
// had grown its own internal structure worth a focused file and test
// suite. No margin-top on the root -- every other labeled section in
// NodeDetailPanel.tsx (Trace links, Tables) renders its content flush
// under its own label, with spacing coming from the PARENT's `mt-1`
// between sections, not between a label and its own content.
export function SourceProvenance({
  sourceRef,
  showScoringNote,
  kbCitations,
}: {
  sourceRef?: SourceRefLike | null;
  showScoringNote: boolean;
  kbCitations?: KbCitation[];
}): React.ReactElement {
  const rows = sourceRef ? sourceRefRows(sourceRef) : [];
  return (
    <div className="flex flex-col gap-2">
      {sourceRef && (
        <div className="flex items-center gap-2">
          <FileText className="h-4 w-4 flex-none text-ink-3" />
          <span className="min-w-0 break-words text-sm font-semibold text-ink-1">{basenameOf(sourceRef.documentPath)}</span>
        </div>
      )}
      {rows.length > 0 && (
        <dl className="flex flex-col gap-1">
          {rows.map((row) => (
            <div key={row.label} className="flex items-baseline gap-2">
              <dt className="w-14 flex-none text-xs text-ink-3">{row.label}</dt>
              <dd className="min-w-0 text-xs text-ink-2">{row.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {showScoringNote && <p className="text-sm text-ink-2">Scored on wording only, not engineering content.</p>}
      {kbCitations && kbCitations.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="text-xs font-semibold text-ink-2">KB references</p>
          <KbCitationChips citations={kbCitations} />
        </div>
      )}
    </div>
  );
}
