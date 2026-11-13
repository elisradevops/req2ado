import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { COUNTED_ACK_KINDS, FIX_WARNING_KINDS, openFixItems } from '../src/modules/pipeline/write-gate';

type Warning = { kind: string; severity: string; nodeIds: string[]; detail: Record<string, unknown>; raw: string; acknowledged?: boolean };
const warning = (kind: string, nodeIds: string[], extra: Partial<Warning> = {}): Warning => ({
  kind, severity: 'needs_review', nodeIds, detail: {}, raw: `${kind} ${nodeIds.join(',')}`, ...extra,
});
const entry = (localId: string, extra: Record<string, unknown> = {}) => ({ localId, parentLocalId: null, action: 'create', ...extra });

describe('openFixItems (the server side of the Write gate)', () => {
  it('has nothing open without warnings', () => {
    expect(openFixItems([], [entry('a')])).toEqual({ remaining: 0, blockers: [] });
  });

  it('counts the items of an open fix kind that have not been decided', () => {
    const result = openFixItems([warning('duplicate_customer_id', ['a', 'b', 'c'])], [entry('a', { reviewed: true }), entry('b'), entry('c')]);
    expect(result.remaining).toBe(2);
    expect(result.blockers).toEqual([{ kind: 'duplicate_customer_id', remaining: 2 }]);
  });

  it('treats an item left out of the write as decided: excluded itself or through an excluded ancestor', () => {
    const diff = [entry('p', { excluded: true }), entry('a', { parentLocalId: 'p' }), entry('b', { excluded: true }), entry('c')];
    const result = openFixItems([warning('duplicate_customer_id', ['a', 'b', 'c'])], diff);
    expect(result.remaining).toBe(1);
  });

  it('treats an item the caller did not select as decided (it is not written)', () => {
    const result = openFixItems([warning('duplicate_customer_id', ['a', 'b'])], [entry('a'), entry('b')], ['a']);
    expect(result.remaining).toBe(1);
    expect(openFixItems([warning('duplicate_customer_id', ['a', 'b'])], [entry('a'), entry('b')], ['c']).remaining).toBe(0);
  });

  it('lets one counted acknowledgement clear a missing-Customer-ID kind, but only once every record is acknowledged', () => {
    const open = openFixItems([warning('missing_source_reference', ['a', 'b'])], [entry('a'), entry('b')]);
    expect(open.remaining).toBe(2);
    const done = openFixItems([warning('missing_source_reference', ['a', 'b'], { acknowledged: true })], [entry('a'), entry('b')]);
    expect(done.remaining).toBe(0);
    const partial = openFixItems(
      [warning('missing_source_reference', ['a'], { acknowledged: true }), warning('missing_source_reference', ['b'], { raw: 'other' })],
      [entry('a'), entry('b')],
    );
    // Still open, and counted like the page counts it: the items nobody decided (both), not the records.
    expect(partial.remaining).toBe(2);
  });

  it('never lets an acknowledgement clear a per-item fix kind that has items: only item decisions do', () => {
    const acknowledged = warning('duplicate_customer_id', ['a', 'b'], { acknowledged: true });
    expect(openFixItems([acknowledged], [entry('a'), entry('b')]).remaining).toBe(2);
    expect(openFixItems([acknowledged], [entry('a', { reviewed: true }), entry('b', { reviewed: true })]).remaining).toBe(0);
  });

  it('clears an item-less fix kind when each of its notices is acknowledged', () => {
    const first = warning('zero_nodes', [], { raw: 'Section 3 produced 0 work items.' });
    const second = warning('zero_nodes', [], { raw: 'Section 7 produced 0 work items.' });
    expect(openFixItems([first, second], [entry('a')]).remaining).toBe(2);
    expect(openFixItems([{ ...first, acknowledged: true }, second], [entry('a')]).remaining).toBe(1);
    expect(openFixItems([{ ...first, acknowledged: true }, { ...second, acknowledged: true }], [entry('a')]).remaining).toBe(0);
  });

  it('never blocks on a review or info kind, an auto-fixed warning, or a legacy plain-string warning', () => {
    const result = openFixItems(
      [
        warning('low_grounding', ['a']),
        warning('enhancement_call_failed', ['a']),
        warning('duplicate_customer_id', ['a'], { severity: 'auto_fixed' }),
        'a legacy warning string' as unknown as Warning,
      ],
      [entry('a')],
    );
    expect(result.remaining).toBe(0);
  });

  it('does not block on an item that is not in the diff at all (nothing to decide on)', () => {
    expect(openFixItems([warning('duplicate_customer_id', ['ghost'])], [entry('a')]).remaining).toBe(0);
  });

  it('sums across kinds and lists each blocker', () => {
    const result = openFixItems(
      [warning('duplicate_customer_id', ['a']), warning('parent_title_collision', ['b', 'c'])],
      [entry('a'), entry('b'), entry('c')],
    );
    expect(result.remaining).toBe(3);
    expect(result.blockers.map((b) => b.kind)).toEqual(['duplicate_customer_id', 'parent_title_collision']);
  });

  it('is linear: 20,000 items against a kind naming all of them', () => {
    const ids = Array.from({ length: 20000 }, (_, i) => `n${i}`);
    const diff = ids.map((id, i) => entry(id, { reviewed: i < 19990 }));
    const started = Date.now();
    const result = openFixItems([warning('duplicate_customer_id', ids)], diff);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(result.remaining).toBe(10);
  });
});

// The browser decides the same thing with its own copy of the kind list (frontend/src/utils/warningKinds.ts), so the two cannot drift
// without a test failing: this reads the frontend file and compares.
describe('the fix-kind list matches the frontend', () => {
  const source = readFileSync(join(__dirname, '..', '..', 'frontend', 'src', 'utils', 'warningKinds.ts'), 'utf8');
  const frontendFixKinds = [...source.matchAll(/^ {2}([a-z_]+): \{\n(?:(?! {2}\},\n).*\n)*? {4}group: 'fix',/gm)].map((m) => m[1]);
  const countedKinds = [...source.matchAll(/^ {2}([a-z_]+): \{\n(?:(?! {2}\},\n).*\n)*? {4}ackPolicy: 'kind_counted',/gm)].map((m) => m[1]);

  it('has the same fix kinds', () => {
    expect(frontendFixKinds.length).toBeGreaterThan(3);
    expect([...FIX_WARNING_KINDS].sort()).toEqual([...frontendFixKinds].sort());
  });

  it('has the same counted-acknowledgement kinds', () => {
    expect([...COUNTED_ACK_KINDS].sort()).toEqual([...countedKinds].sort());
  });
});
