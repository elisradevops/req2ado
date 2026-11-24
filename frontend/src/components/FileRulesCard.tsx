import { useState } from 'react';
import { Pencil, RefreshCw } from 'lucide-react';
import { ElapsedTimer } from './ElapsedTimer';
import { Alert } from '../ui/Alert';
import { Button } from '../ui/Button';
import { Disclosure } from '../ui/Disclosure';
import { SectionCard } from '../ui/SectionCard';
import { Select } from '../ui/Select';
import { Spinner } from '../ui/Spinner';
import type { RulebookDetails, RulebookSample, RulebookView } from '../api/jobs';
import { cn } from '../lib/cn';
import { plural } from '../utils/plural';

// 'cancelled': the wizard stopped waiting. The job reads the file's layout itself when it starts.
export type RulesStatus = 'idle' | 'loading' | 'ready' | 'error' | 'cancelled';

const SOURCE_LABEL: Record<RulebookView['source'], string> = {
  model: 'Read by the model, checked against every row',
  user: 'Your edit, checked against the file',
  none: 'Nothing the model could verify',
};
const TYPE_CHOICES = ['Epic', 'Feature', 'Requirement', 'Not imported'] as const;

type Edits = {
  /** table id -> value -> type */
  types: Record<string, Record<string, string>>;
  /** index of the label in document.labels -> type */
  labels: Record<number, string>;
};

function tablesOf(rulebook: Record<string, unknown>): Record<string, { type_map?: Record<string, string | null> | null }> {
  const tables = rulebook.tables;
  return tables && typeof tables === 'object' ? (tables as Record<string, { type_map?: Record<string, string | null> | null }>) : {};
}

function labelsOf(rulebook: Record<string, unknown>): { label: string; separator: string; type: string }[] {
  const document = rulebook.document as { labels?: { label: string; separator: string; type: string }[] } | null | undefined;
  return Array.isArray(document?.labels) ? document.labels : [];
}

/** The rulebook with the user's choices applied: a type map value of "Not imported" is null, and everything else is left exactly as it was. */
export function applyEdits(rulebook: Record<string, unknown>, edits: Edits): Record<string, unknown> {
  const copy = JSON.parse(JSON.stringify(rulebook)) as Record<string, unknown>;
  const tables = tablesOf(copy);
  for (const [tableId, values] of Object.entries(edits.types)) {
    const map = tables[tableId]?.type_map;
    if (!map) continue;
    for (const [value, type] of Object.entries(values)) map[value] = type === 'Not imported' ? null : type;
  }
  const labels = (copy.document as { labels?: { type: string }[] } | null | undefined)?.labels;
  for (const [index, type] of Object.entries(edits.labels)) {
    const entry = labels?.[Number(index)];
    if (entry && type !== 'Not imported') entry.type = type;
  }
  return copy;
}

const LADDER = ['Epic', 'Feature', 'Requirement'] as const;

/** Why a row is not imported, in words; the file's own text is left exactly as written. */
export function reasonPhrase(code: string): string {
  if (code.startsWith('type:')) return `type “${code.slice('type:'.length)}” is not an Epic, Feature or Requirement`;
  return { under_skipped: 'sits under a row that is not imported', in_cycle: 'its parents form a cycle', no_title: 'has no title', no_type: 'states no type' }[code] ?? code;
}

function Samples({ samples }: { samples: Partial<Record<string, RulebookSample[]>> }): React.ReactElement {
  return (
    <div className="flex flex-col gap-2.5">
      {LADDER.filter((type) => samples[type]?.length).map((type) => (
        <div key={type} className="flex flex-col gap-1">
          <p className="text-xs font-semibold text-ink-3">{type}</p>
          <ul className="flex flex-col gap-1 text-sm text-ink-1">
            {samples[type]!.map((sample, index) => (
              <li key={`${sample.row ?? index}`} className="flex flex-col">
                <span className="flex gap-2">
                  {sample.row !== null && <span className="flex-none font-mono text-meta tabular-nums text-ink-3">row {sample.row}</span>}
                  <span dir="auto" className="min-w-0 break-words">
                    {sample.title}
                  </span>
                </span>
                {sample.parent && (
                  <span dir="auto" className="break-words text-xs text-ink-3">
                    ↳ under {sample.parent}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/** What the rules make of the file: counts per type, a few examples, and the rows that are not imported with the reason. Closed by default. */
function RulesBreakdown({ details }: { details: RulebookDetails }): React.ReactElement {
  const named = details.tables.length > 1;
  return (
    <div className="flex flex-col gap-2" data-testid="file-rules-breakdown">
      {details.tables.map((table, index) => (
        <div key={`${index}:${table.name}`} className="flex flex-col gap-2">
          <p className="text-sm text-ink-2" data-testid="file-rules-counts">
            {named && <span dir="auto">{table.name}: </span>}
            {LADDER.map((type) => `${type} ${table.typeCounts[type].toLocaleString('en-US')}`).join(' · ')}
            {table.skipped.count > 0 && ` · Not imported ${plural(table.skipped.count, 'row')}`}
          </p>
          <Disclosure title={named ? `Examples from ${table.name}` : 'Show examples'}>
            <Samples samples={table.samples} />
          </Disclosure>
          {table.skipped.count > 0 && (
            <Disclosure title={`Rows not imported (${table.skipped.count.toLocaleString('en-US')})`}>
              <ul className="flex flex-col gap-1 text-sm text-ink-2">
                {Object.entries(table.skipped.byReason).map(([code, count]) => (
                  <li key={code} dir="auto" className="break-words">
                    {plural(count, 'row')}: {reasonPhrase(code)}
                  </li>
                ))}
              </ul>
              <ul className="flex flex-col gap-1 text-sm text-ink-1">
                {table.skipped.rows.map((row) => (
                  <li key={row.row} className="flex gap-2">
                    <span className="flex-none font-mono text-meta tabular-nums text-ink-3">row {row.row}</span>
                    <span className="min-w-0 break-words">
                      <span dir="auto">{row.text || '(empty)'}</span> <span className="text-xs text-ink-3">· {reasonPhrase(row.reason)}</span>
                    </span>
                  </li>
                ))}
              </ul>
              {table.skipped.more > 0 && <p className="text-xs text-ink-3">+{table.skipped.more.toLocaleString('en-US')} more</p>}
            </Disclosure>
          )}
        </div>
      ))}
      {details.document && (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-ink-2" data-testid="file-rules-counts">
            {LADDER.filter((type) => details.document!.typeCounts[type] > 0)
              .map((type) => `about ${plural(details.document!.typeCounts[type], type)}`)
              .join(', ')}{' '}
            <span className="text-xs text-ink-3">(from the headings the rules type; the build may differ slightly)</span>
          </p>
          <Disclosure title="Show examples">
            <Samples samples={details.document.samples} />
          </Disclosure>
        </div>
      )}
    </div>
  );
}

interface Props {
  status: RulesStatus;
  view: RulebookView | null;
  error: string | null;
  /** Which model reads the file ("Default" when the deployment's default does), shown as one small line. */
  modelLabel?: string;
  /** When the reading started (ISO), for the elapsed time while it runs. */
  startedAt?: string;
  /** Set when the job will use another model than the one that read the file: both named, with an offer to read again with the job's. */
  modelHint?: { readWith: string; jobUses: string } | null;
  onRelearn: () => void;
  /** Stops waiting for the reading (the job reads the file itself when it starts). */
  onStopWaiting: () => void;
  /** After stopping: reads the file now after all. */
  onReadNow: () => void;
  /** Saves an edit. Resolves to null when the file accepted it, or to the reason it did not (shown here, the edit stays open). */
  onSaveEdit: (rulebook: Record<string, unknown>) => Promise<string | null>;
  /** Inside the wizard's one "This file and how it will be read" card: only how items are built, no card, intro or waiting of its own (the
   *  outer card has the one status line, timer and "Stop waiting"). */
  embedded?: boolean;
}

/** The reading was refused because the model could not be reached at all, not because the file states nothing: a connection to check. */
export function modelUnreachable(view: RulebookView | null): boolean {
  return Boolean(view?.warnings.some((w) => w.kind === 'prestudy_rejected' && /could not be asked/i.test(String((w.detail as { reason?: unknown } | undefined)?.reason ?? w.raw ?? ''))));
}

/**
 * How the file's own structure will be read: the model names the conventions the file uses (which column is the type, how rows nest, which labels state
 * a type), every answer is checked against the whole file, and only code builds the items from it. The reviewer sees the rules in words, can read them
 * again or correct how a type is mapped, and the job is built from exactly what is shown here.
 */
export function FileRulesCard({ status, view, error, modelLabel, startedAt, modelHint, onRelearn, onStopWaiting, onReadNow, onSaveEdit, embedded }: Props): React.ReactElement | null {
  const [editing, setEditing] = useState(false);
  const [edits, setEdits] = useState<Edits>({ types: {}, labels: {} });
  const [saving, setSaving] = useState(false);
  const [rejection, setRejection] = useState<string | null>(null);

  const tables = view ? tablesOf(view.rulebook) : {};
  const editableTables = Object.entries(tables).filter(([, spec]) => spec.type_map && Object.keys(spec.type_map).length > 0);
  const labels = view ? labelsOf(view.rulebook) : [];
  const canEdit = view?.id != null && (editableTables.length > 0 || labels.length > 0);
  const reason = view?.warnings.find((w) => w.kind === 'prestudy_rejected')?.raw;

  async function save(): Promise<void> {
    if (!view) return;
    setSaving(true);
    setRejection(null);
    const message = await onSaveEdit(applyEdits(view.rulebook, edits));
    setSaving(false);
    if (message === null) {
      setEditing(false);
      setEdits({ types: {}, labels: {} });
    } else {
      setRejection(message);
    }
  }

  const editForm = (
    <div className="flex flex-col gap-2.5 rounded-md border border-hairline p-3" data-testid="file-rules-edit">
                {editableTables.map(([tableId, spec]) =>
                  Object.entries(spec.type_map ?? {}).map(([value, type]) => (
                    <div key={`${tableId}:${value}`} className="grid grid-cols-[minmax(0,1fr)_minmax(0,12rem)] items-center gap-3">
                      <span dir="auto" className="break-words text-sm text-ink-1">
                        Rows typed “{value}” are
                      </span>
                      <Select
                        aria-label={`Type for rows typed ${value}`}
                        value={edits.types[tableId]?.[value] ?? type ?? 'Not imported'}
                        onChange={(event) =>
                          setEdits((current) => ({ ...current, types: { ...current.types, [tableId]: { ...current.types[tableId], [value]: event.target.value } } }))
                        }
                      >
                        {TYPE_CHOICES.map((choice) => (
                          <option key={choice} value={choice}>
                            {choice}
                          </option>
                        ))}
                      </Select>
                    </div>
                  )),
                )}
                {labels.map((label, index) => (
                  <div key={`${label.label}${label.separator}`} className="grid grid-cols-[minmax(0,1fr)_minmax(0,12rem)] items-center gap-3">
                    <span dir="auto" className="break-words text-sm text-ink-1">
                      Headings that begin “{label.label}
                      {label.separator}” are
                    </span>
                    <Select
                      aria-label={`Type for headings that begin ${label.label}`}
                      value={edits.labels[index] ?? label.type}
                      onChange={(event) => setEdits((current) => ({ ...current, labels: { ...current.labels, [index]: event.target.value } }))}
                    >
                      {TYPE_CHOICES.filter((choice) => choice !== 'Not imported').map((choice) => (
                        <option key={choice} value={choice}>
                          {choice}
                        </option>
                      ))}
                    </Select>
                  </div>
                ))}
                {rejection && <Alert severity="error">{rejection}</Alert>}
                <div className="flex items-center gap-2">
                  <Button onClick={() => void save()} disabled={saving}>
                    {saving ? <Spinner /> : null}
                    {saving ? 'Checking…' : 'Save changes'}
                  </Button>
                  <Button variant="outline" onClick={() => { setEditing(false); setRejection(null); setEdits({ types: {}, labels: {} }); }} disabled={saving}>
                    Cancel
                  </Button>
                </div>
              </div>
  );

  if (embedded) {
    if (status === 'error') {
      return (
        <Alert severity="warning">
          <div className="flex flex-col gap-2">
            <span>{error || "The file's layout could not be read."} Items are built from the file's own headings and numbering.</span>
            <div>
              <Button variant="outline" onClick={onRelearn}>
                <RefreshCw className="h-3.5 w-3.5" /> Try again
              </Button>
            </div>
          </div>
        </Alert>
      );
    }
    if (status !== 'ready' || !view) return null;
    if (view.skipped) return <p className="text-sm text-ink-2" data-testid="file-rules-skipped">{view.skipped}</p>;
    if (modelUnreachable(view)) {
      return (
        <Alert severity="warning">
          <div className="flex flex-col gap-2" data-testid="file-rules-unreachable">
            <span>
              Your model connection did not answer, so the model did not read the file&apos;s layout. Items are built from the file&apos;s own headings and
              numbering. Check the connection, then read again.
            </span>
            <div>
              <Button variant="outline" onClick={onRelearn}>
                <RefreshCw className="h-3.5 w-3.5" /> Read again
              </Button>
            </div>
          </div>
        </Alert>
      );
    }
    return (
      <div className="flex flex-col gap-2.5" data-testid="file-rules-card">
        {view.rules.length > 0 ? (
          <ul className="flex flex-col gap-1.5 text-sm text-ink-1">
            {view.rules.map((rule) => (
              <li key={rule} dir="auto" className="break-words">
                {rule}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-ink-1">
            The file does not name its item types in words, so items are built from its own headings and numbering: each section heading is a Feature, each
            requirement under it is a Requirement.
          </p>
        )}
        {modelHint && (
          <p className="text-xs text-ink-2" data-testid="file-rules-model-hint">
            Read with {modelHint.readWith}. This job will use {modelHint.jobUses}.{' '}
            <button type="button" className="font-medium text-accent underline underline-offset-2 hover:no-underline" onClick={onRelearn}>
              Read again with {modelHint.jobUses}
            </button>
          </p>
        )}
        {view.details && <RulesBreakdown details={view.details} />}
        {editing && canEdit && editForm}
        <div className={cn('flex flex-wrap items-center gap-2', editing && 'hidden')}>
          {canEdit && (
            <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
              <Pencil className="h-3.5 w-3.5" /> Edit types
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={onRelearn}>
            <RefreshCw className="h-3.5 w-3.5" /> Read again
          </Button>
          <span className="text-xs text-ink-3">
            {view.source === 'none' ? 'Nothing for the model to verify' : SOURCE_LABEL[view.source]}
            {view.reused ? ' · reused from an earlier upload of this file' : ''}
          </span>
          {view.source !== 'none' && (
            <span className="font-mono text-meta text-ink-3" title="The same file with the same rules always gives the same items">
              rules {view.hash.slice(0, 8)}
            </span>
          )}
        </div>
      </div>
    );
  }

  return (
    <SectionCard title="How this file is read">
      <div className="flex flex-col gap-3" data-testid="file-rules-card">
        <p className="text-xs text-ink-3">
          The model names how the file states its types and nesting; code checks that against every row and builds the items from it. It never writes the
          items. This runs for every file, in both modes.
        </p>
        {modelLabel && status !== 'idle' && status !== 'cancelled' && !view?.skipped && <p className="font-mono text-meta text-ink-3">Model: {modelLabel}</p>}

        {status === 'idle' && <p className="text-sm text-ink-3">Waiting for the file to be read.</p>}

        {status === 'loading' && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <p className="flex items-center gap-2 text-sm text-ink-2" role="status">
              <Spinner /> Reading the file's conventions. This can take a few minutes the first time; the job can start once it is read.
            </p>
            {/* Outside the status region: a clock announced every second would drown the message. */}
            {startedAt && (
              <span className="text-meta text-ink-3" data-testid="file-rules-elapsed">
                <ElapsedTimer startedAt={startedAt} /> so far
              </span>
            )}
            <Button size="sm" variant="outline" onClick={onStopWaiting}>
              Stop waiting
            </Button>
          </div>
        )}

        {status === 'cancelled' && (
          <div className="flex flex-col gap-2" data-testid="file-rules-cancelled">
            <p className="text-sm text-ink-2">Stopped waiting. The job will read the file's layout when it starts, which adds time to the job.</p>
            <div>
              <Button variant="outline" onClick={onReadNow}>
                Read now instead
              </Button>
            </div>
          </div>
        )}

        {status === 'error' && (
          <Alert severity="warning">
            <div className="flex flex-col gap-2">
              <span>{error || "The file's conventions could not be read."} The file will be read by its recognised headings and its shape.</span>
              <div>
                <Button variant="outline" onClick={onRelearn}>
                  <RefreshCw className="h-3.5 w-3.5" /> Try again
                </Button>
              </div>
            </div>
          </Alert>
        )}

        {status === 'ready' && view?.skipped && (
          <p className="text-sm text-ink-2" data-testid="file-rules-skipped">
            {view.skipped}
          </p>
        )}

        {status === 'ready' && view && !view.skipped && (
          <div className="flex flex-col gap-2.5">
            <p className="text-xs font-semibold uppercase tracking-wide text-ink-3">
              {SOURCE_LABEL[view.source]}
              {view.reused ? ' · reused from an earlier upload of this file' : ''}
            </p>
            {modelHint && (
              <p className="text-xs text-ink-2" data-testid="file-rules-model-hint">
                Read with {modelHint.readWith}. This job will use {modelHint.jobUses}.{' '}
                <button type="button" className="font-medium text-accent underline underline-offset-2 hover:no-underline" onClick={onRelearn}>
                  Read again with {modelHint.jobUses}
                </button>
              </p>
            )}
            {view.rules.length > 0 ? (
              <ul className="flex flex-col gap-1.5 text-sm text-ink-1">
                {view.rules.map((rule) => (
                  <li key={rule} dir="auto" className="break-words">
                    {rule}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-ink-2">
                {reason || 'Nothing could be verified against the file.'} The file will be read by its recognised headings and its shape.
              </p>
            )}

            {view.details ? (
              <RulesBreakdown details={view.details} />
            ) : (
              view.source !== 'none' && (
                <p className="text-xs text-ink-3" data-testid="file-rules-no-breakdown">
                  Read again to see the breakdown.
                </p>
              )
            )}

            {editing && canEdit && editForm}

            <div className={cn('flex flex-wrap items-center gap-2', editing && 'hidden')}>
              {canEdit && (
                <Button variant="outline" onClick={() => setEditing(true)}>
                  <Pencil className="h-3.5 w-3.5" /> Edit types
                </Button>
              )}
              <Button variant="outline" onClick={onRelearn}>
                <RefreshCw className="h-3.5 w-3.5" /> Read again
              </Button>
              <span className="font-mono text-meta text-ink-3" title="The same file with the same rules always gives the same items">
                rules {view.hash.slice(0, 8)}
              </span>
            </div>
          </div>
        )}
      </div>
    </SectionCard>
  );
}
