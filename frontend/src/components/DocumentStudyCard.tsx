import { ElapsedTimer } from './ElapsedTimer';
import { Alert } from '../ui/Alert';
import { Disclosure } from '../ui/Disclosure';
import { ProgressBar } from '../ui/ProgressBar';
import { SectionCard } from '../ui/SectionCard';
import type { DocumentStudy } from '../api/jobs';
import { plural } from '../utils/plural';

// 'waiting': the file's layout is still being read (the Study reads the tables by it). 'skipped': this job reads no Study (a BASELINE job of
// a user with no model connection), so there is nothing to show.
export type StudyStatus = 'waiting' | 'reading' | 'ready' | 'skipped' | 'error';

const ORIENTATION_LABELS: [keyof DocumentStudy['orientation'], string][] = [
  ['document_type', 'Document type'],
  ['purpose', 'Purpose'],
  ['system', 'System'],
  ['conventions', 'How it states requirements'],
];
const VALUES_SHOWN = 8;

function count(n: number, one: string, many: string): string | null {
  return n > 0 ? plural(n, one, many) : null;
}

function StudyFindings({ study }: { study: DocumentStudy }): React.ReactElement {
  const orientation = ORIENTATION_LABELS.filter(([key]) => study.orientation[key]);
  const counts = [
    count(study.verification_statements.length, 'verification statement', 'verification statements'),
    count(study.standards_cited.length, 'standard cited', 'standards cited'),
    count(study.glossary.length, 'defined term', 'defined terms'),
    count(study.placeholder_tokens.length, 'open-value marker', 'open-value markers'),
  ].filter(Boolean);
  const { windows_studied: read, windows_total: total } = study.stats;
  return (
    <div className="flex flex-col gap-3" data-testid="document-study-findings">
      {orientation.length > 0 ? (
        // Label above value on a narrow screen (a long label would squeeze the value into a thin column); side by side from sm up.
        <dl className="grid grid-cols-1 gap-x-3 gap-y-1 text-sm sm:grid-cols-[max-content_1fr]">
          {orientation.map(([key, label]) => (
            <div key={key} className="contents">
              <dt className="text-ink-3">{label}</dt>
              <dd className="min-w-0 break-words text-ink">{study.orientation[key]}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="text-sm text-ink-2">The overview of the document could not be written; the job starts with what the reading found.</p>
      )}
      {counts.length > 0 && <p className="text-xs text-ink-2">Found {counts.join(' · ')}.</p>}
      {total > 0 && read < total && (
        <Alert severity="info">
          Read {read} of {total} parts of the document. The job starts with what was read and says so in its warnings.
        </Alert>
      )}
      {study.vocabulary.length > 0 && (
        <Disclosure title="Values the tables use" summary={plural(study.vocabulary.length, 'column')}>
          <ul className="flex flex-col gap-1 text-sm">
            {study.vocabulary.map((column) => {
              const shown = column.values.slice(0, VALUES_SHOWN);
              const more = column.values.length - shown.length + column.more;
              return (
                <li key={`${column.table}/${column.column}`} className="min-w-0 break-words">
                  <span className="text-ink-3">{column.column}:</span> {shown.join(', ')}
                  {more > 0 && <span className="text-ink-3"> and {more} more</span>}
                </li>
              );
            })}
          </ul>
        </Disclosure>
      )}
      {(study.glossary.length > 0 || study.placeholder_tokens.length > 0) && (
        <Disclosure title="Terms and open-value markers">
          <ul className="flex flex-col gap-1 text-sm">
            {study.glossary.map((entry) => (
              <li key={entry.term} className="min-w-0 break-words">
                <span className="font-semibold">{entry.term}</span> — {entry.definition}
              </li>
            ))}
            {study.placeholder_tokens.length > 0 && (
              <li className="min-w-0 break-words">
                <span className="text-ink-3">Marks a value still open:</span> <span className="font-mono">{study.placeholder_tokens.join(', ')}</span>
              </li>
            )}
          </ul>
        </Disclosure>
      )}
    </div>
  );
}

export function DocumentStudyCard({
  status,
  done,
  total,
  study,
  error,
  startedAt,
}: {
  status: StudyStatus;
  done: number;
  total: number;
  study: DocumentStudy | null;
  error: string | null;
  startedAt?: string;
}): React.ReactElement | null {
  if (status === 'skipped') return null;
  return (
    <SectionCard title="Reading and analyzing the document">
      <div className="flex flex-col gap-3" data-testid="document-study-card">
        <p className="text-xs text-ink-3">
          The model reads the whole document once, so the job&apos;s later steps know its terms, its conventions and how it states verification. It
          never writes the items. The job can start once it is read.
        </p>
        {status === 'waiting' && <p className="text-sm text-ink-3">Starts once the file&apos;s layout is read.</p>}
        {status === 'reading' && (
          <div className="flex flex-col gap-2">
            {/* A real denominator only once the server has said how many parts there are (DESIGN.md section 12: never a made-up number). */}
            <ProgressBar
              label="Reading the document"
              value={total > 0 ? (100 * done) / total : undefined}
              valueText={total > 0 ? `Part ${Math.min(done + 1, total)} of ${total}` : 'Starting'}
            />
            <div className="flex flex-wrap items-center gap-x-3">
              <p className="text-sm text-ink-2" role="status">
                {total > 0 ? `Reading part ${Math.min(done + 1, total)} of ${total}.` : 'Starting to read the document.'}
              </p>
              {/* Outside the status region: a clock announced every second would drown the message. */}
              {startedAt && (
                <span className="text-meta text-ink-3" data-testid="document-study-elapsed">
                  <ElapsedTimer startedAt={startedAt} /> so far
                </span>
              )}
            </div>
          </div>
        )}
        {status === 'ready' && study && <StudyFindings study={study} />}
        {status === 'error' && (
          <Alert severity="warning">
            {error ?? 'The document could not be read.'} The job can start without it, and will say so in its warnings.
          </Alert>
        )}
      </div>
    </SectionCard>
  );
}
