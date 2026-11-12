import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { Spinner } from '../ui/Spinner';
import type { KbProfileRead } from '../hooks/useKbProfile';

// One line about the knowledge base as the grading rubric sees it, with the two things to do about it: read the last ingestion
// report, and customize the rubric. It says only what the profile says, and says nothing while that is still being read, rather
// than show a wrong number.

interface Props {
  rubric: KbProfileRead;
  // There is a finished batch whose report can be opened.
  hasReport?: boolean;
  onViewReport: () => void;
  onCustomizeRubric: () => void;
}

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

function line(rubric: KbProfileRead): React.ReactNode {
  const { status, profile } = rubric;
  switch (status) {
    case 'idle':
    case 'loading':
      return null;
    case 'waiting':
      return (
        <span role="status" className="flex items-center gap-2">
          <Spinner className="h-3.5 w-3.5 text-live" />
          Updating the grading rubric…
        </span>
      );
    case 'none':
      return 'No documents yet, so no rubric yet. It is built once you add some.';
    case 'no_model':
      return 'No model connection is set up to build the rubric with. Your first job builds it with its own.';
    case 'timeout':
      return 'The rubric is still not updated after 10 minutes. It keeps going on its own; check back later.';
    case 'error':
      return 'Could not read the rubric status. Trying again.';
    case 'ready':
      if (!profile) return null;
      return (
        <>
          The grading rubric draws on {profile.docsContributing} of {profile.docsInKb} {plural(profile.docsInKb, 'document', 'documents')}
          {profile.builtAt ? ` · built ${new Date(profile.builtAt).toLocaleString()}` : ''}
        </>
      );
  }
}

export function KbHealthSummary({ rubric, hasReport = false, onViewReport, onCustomizeRubric }: Props): React.ReactElement {
  return (
    <Card>
      <div role="region" aria-label="Knowledge base health" className="flex flex-wrap items-center gap-x-4 gap-y-2 p-3.5">
        <div className="min-w-0 flex-1 text-sm text-ink-2">{line(rubric)}</div>
        <div className="flex items-center gap-1.5">
          {hasReport && (
            <Button size="sm" variant="outline" onClick={onViewReport}>
              View the last report
            </Button>
          )}
          {rubric.status === 'ready' && (
            <Button size="sm" variant="outline" onClick={onCustomizeRubric}>
              Customize the rubric
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}
