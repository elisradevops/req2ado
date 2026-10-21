import { useCallback, useEffect, useState } from 'react';
import { Plus, RotateCcw, X } from 'lucide-react';
import { getRubric, putRubric, type Rubric, type RubricCategory, type RubricInput } from '../api/kb';
import { useToast } from './ToastProvider';
import { Alert } from '../ui/Alert';
import { Button } from '../ui/Button';
import { Checkbox } from '../ui/Checkbox';
import { Chip } from '../ui/Chip';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { SectionCard } from '../ui/SectionCard';
import { Skeleton } from '../ui/Skeleton';
import { TextArea, TextField } from '../ui/TextField';

interface Row {
  name: string;
  passCondition: string;
  /** The text the rubric derived (what an unpin hands the category back to). */
  derived: string;
  pinned: boolean;
  custom: boolean;
  mergedFrom: string[];
  index: number;
}

const norm = (text: string): string => text.trim().replace(/\s+/g, ' ').toLowerCase();

function rowsOf(rubric: Rubric): Row[] {
  return rubric.categories.map((c: RubricCategory, index) => ({
    name: c.name,
    passCondition: c.passCondition ?? '',
    derived: c.passCondition ?? '',
    pinned: c.pinned || c.origin === 'custom',
    custom: c.origin === 'custom',
    mergedFrom: c.mergedFrom,
    index,
  }));
}

function payloadOf(rows: Row[], removed: string[]): RubricInput {
  return { pinned: rows.filter((r) => r.pinned).map((r) => ({ name: r.name, passCondition: r.passCondition })), removed };
}

/**
 * The rubric the user's jobs are graded against, as something to review and control: every category with its pass condition and where it
 * comes from (their knowledge base, or the built-in rubric), what was merged into it, and what they pinned, added or removed. Pins are the
 * user's decision: they hold for every job and survive a rebuild of the profile.
 */
export function RubricPanel(): React.ReactElement {
  const { showToast, showErrorToast } = useToast();
  const [rubric, setRubric] = useState<Rubric | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [removed, setRemoved] = useState<string[]>([]);
  const [removedRows, setRemovedRows] = useState<Row[]>([]); // removed in this session: can come back with their text
  const [saving, setSaving] = useState(false);
  const [newName, setNewName] = useState('');
  const [newCondition, setNewCondition] = useState('');
  const [confirmReset, setConfirmReset] = useState(false);

  const adopt = useCallback((next: Rubric) => {
    setRubric(next);
    setRows(rowsOf(next));
    setRemoved(next.removed);
    setRemovedRows([]);
  }, []);

  const load = useCallback(() => {
    setLoadFailed(false);
    setRubric(null);
    void (async () => {
      const next = await getRubric();
      if (!next || !Array.isArray(next.categories)) throw new Error('unexpected answer');
      adopt(next);
    })().catch(() => setLoadFailed(true));
  }, [adopt]);

  useEffect(load, [load]);

  const initial = rubric ? JSON.stringify(payloadOf(rowsOf(rubric), rubric.removed)) : '';
  const dirty = rubric !== null && JSON.stringify(payloadOf(rows, removed)) !== initial;
  const taken = new Set([...rows.map((r) => norm(r.name)), ...removedRows.map((r) => norm(r.name)), ...removed.map(norm)]);
  const duplicate = newName.trim() !== '' && taken.has(norm(newName));
  const canAdd = newName.trim() !== '' && newCondition.trim() !== '' && !duplicate;

  const edit = (name: string, passCondition: string) => setRows((prev) => prev.map((r) => (r.name === name ? { ...r, passCondition, pinned: true } : r))); // editing pins
  const setPinned = (name: string, pinned: boolean) =>
    setRows((prev) => prev.map((r) => (r.name === name ? { ...r, pinned, passCondition: pinned ? r.passCondition : r.derived } : r))); // unpinning hands it back

  function remove(row: Row): void {
    setRows((prev) => prev.filter((r) => r.name !== row.name));
    if (!row.custom) {
      setRemoved((prev) => [...prev, row.name]);
      setRemovedRows((prev) => [...prev, row]);
    }
  }

  function restore(name: string): void {
    const row = removedRows.find((r) => r.name === name);
    setRemoved((prev) => prev.filter((n) => n !== name));
    if (row) {
      setRemovedRows((prev) => prev.filter((r) => r.name !== name));
      setRows((prev) => [...prev, row].sort((a, b) => a.index - b.index));
    }
  }

  function add(): void {
    if (!canAdd) return;
    setRows((prev) => [...prev, { name: newName.trim().replace(/\s+/g, ' '), passCondition: newCondition.trim(), derived: '', pinned: true, custom: true, mergedFrom: [], index: prev.length + 1000 }]);
    setNewName('');
    setNewCondition('');
  }

  async function save(input: RubricInput, done: string): Promise<void> {
    setSaving(true);
    try {
      adopt(await putRubric(input));
      showToast(done, 'success');
    } catch (err) {
      showErrorToast('Could not save the rubric.', err);
    } finally {
      setSaving(false);
    }
  }

  const header = (
    <>
      <p className="text-sm text-ink-2">
        What your jobs are graded against. A category you pin, edit or add stays exactly as you set it when your knowledge base changes.
      </p>
      {rubric && (
        <p className="mt-1 text-xs text-ink-3">
          {rubric.source === 'kb' ? 'From your knowledge base' : 'Built-in rubric'}
          {rubric.builtAt ? ` · built ${new Date(rubric.builtAt).toLocaleDateString()}` : ''}
          {rubric.source === 'default' && ' · Add documents to your knowledge base to grade against your own standard. You can still pin, edit, add and remove categories here.'}
        </p>
      )}
    </>
  );

  return (
    <SectionCard title="Quality rubric">
      <div className="flex flex-col gap-3">
        {header}
        {loadFailed ? (
          <Alert severity="error">
            <div className="flex items-center justify-between gap-2">
              <span>Could not load the rubric.</span>
              <Button size="sm" variant="outline" onClick={load}>
                Try again
              </Button>
            </div>
          </Alert>
        ) : !rubric ? (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : (
          <>
            <ul className="flex flex-col gap-2">
              {rows.map((row) => (
                <li key={row.name} className="flex flex-col gap-1 rounded-sm border border-hairline bg-surface-alt p-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-2 text-sm font-semibold text-ink-1">
                      {row.name}
                      {row.custom ? <Chip className="bg-accent-soft text-accent-ink">Your own</Chip> : row.pinned ? <Chip className="bg-accent-soft text-accent-ink">Pinned</Chip> : null}
                    </span>
                    <span className="flex items-center gap-2">
                      <label className="flex items-center gap-1.5 text-xs text-ink-2">
                        <Checkbox checked={row.pinned} onCheckedChange={(v) => setPinned(row.name, v)} disabled={row.custom} ariaLabel={`Pin ${row.name}`} />
                        Pinned
                      </label>
                      <Button size="sm" variant="ghost" onClick={() => remove(row)} aria-label={`Remove ${row.name}`}>
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </span>
                  </div>
                  <TextArea aria-label={`Pass condition of ${row.name}`} value={row.passCondition} onChange={(e) => edit(row.name, e.target.value)} rows={2} fullWidth />
                  {row.mergedFrom.length > 1 && <p className="text-micro text-ink-3">Also written as: {row.mergedFrom.join(', ')}</p>}
                </li>
              ))}
            </ul>

            {removed.length > 0 && (
              <p className="text-xs text-ink-2">
                Removed: {removed.join(', ')}{' '}
                {removed.map((name) => (
                  <Button key={name} size="sm" variant="ghost" onClick={() => restore(name)} aria-label={`Restore ${name}`}>
                    Restore {name}
                  </Button>
                ))}
              </p>
            )}

            <div className="flex flex-col gap-1.5 rounded-sm border border-dashed border-hairline-strong p-2.5">
              <p className="text-xs font-semibold text-ink-2">Add a category of your own</p>
              <TextField aria-label="New category name" placeholder="Name" value={newName} onChange={(e) => setNewName(e.target.value)} fullWidth />
              <TextArea aria-label="New category pass condition" placeholder="What an item must show to pass" value={newCondition} onChange={(e) => setNewCondition(e.target.value)} rows={2} fullWidth />
              {duplicate && <p className="text-xs text-danger-ink">That name is already in the rubric.</p>}
              <div>
                <Button size="sm" variant="outline" onClick={add} disabled={!canAdd}>
                  <Plus className="h-3 w-3" />
                  Add category
                </Button>
              </div>
            </div>

            <div className="flex items-center justify-between gap-2">
              <Button size="sm" variant="ghost" onClick={() => setConfirmReset(true)} disabled={saving}>
                <RotateCcw className="h-3 w-3" />
                Reset to the derived rubric
              </Button>
              <Button onClick={() => void save(payloadOf(rows, removed), 'Rubric saved.')} disabled={!dirty} loading={saving}>
                Save rubric
              </Button>
            </div>
          </>
        )}
      </div>
      <ConfirmDialog
        open={confirmReset}
        onOpenChange={setConfirmReset}
        title="Reset the rubric?"
        description="Every pin, edit, addition and removal is dropped, and your jobs are graded against the derived rubric again."
        confirmLabel="Reset"
        onConfirm={() => {
          setConfirmReset(false);
          void save({ pinned: [], removed: [] }, 'Rubric reset.');
        }}
      />
    </SectionCard>
  );
}
