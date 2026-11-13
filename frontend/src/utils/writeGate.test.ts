import { describe, it, expect } from 'vitest';
import { buildKindGroups } from './warningKinds';
import { computeWriteGate } from './writeGate';
import type { WarningRecord } from './warnings';

function warning(overrides: Partial<WarningRecord> & Pick<WarningRecord, 'kind' | 'severity' | 'raw'>): WarningRecord {
  return { nodeIds: [], detail: {}, ...overrides };
}

const none: ReadonlySet<string> = new Set();

describe('computeWriteGate', () => {
  it('is open when there are no warnings', () => {
    const gate = computeWriteGate(buildKindGroups([]), none);
    expect(gate.blocked).toBe(false);
    expect(gate.remaining).toBe(0);
    expect(gate.blockers).toEqual([]);
  });

  it('blocks on an open fix kind and counts the items still to decide', () => {
    const groups = buildKindGroups([
      warning({ kind: 'duplicate_customer_id', severity: 'needs_review', raw: 'a', nodeIds: ['n1', 'n2', 'n3'] }),
    ]);
    const gate = computeWriteGate(groups, new Set(['n1']));
    expect(gate.blocked).toBe(true);
    expect(gate.remaining).toBe(2);
    expect(gate.blockers).toHaveLength(1);
    expect(gate.firstBlocker?.kind).toBe('duplicate_customer_id');
    expect(gate.firstBlocker?.nodeIds).toEqual(['n2', 'n3']);
  });

  it('opens once every affected item is reviewed or excluded (handled)', () => {
    const groups = buildKindGroups([
      warning({ kind: 'duplicate_customer_id', severity: 'needs_review', raw: 'a', nodeIds: ['n1', 'n2'] }),
    ]);
    expect(computeWriteGate(groups, new Set(['n1', 'n2'])).blocked).toBe(false);
  });

  it('never blocks on review, info or auto-fixed warnings', () => {
    const groups = buildKindGroups([
      warning({ kind: 'criteria_value_ungrounded', severity: 'needs_review', raw: 'r', nodeIds: ['n1'] }),
      warning({ kind: 'duplicate_customer_id', severity: 'auto_fixed', raw: 'f', nodeIds: ['n2'] }),
    ]);
    expect(computeWriteGate(groups, none).blocked).toBe(false);
  });

  it('a counted acknowledgement clears a kind that allows it', () => {
    const open = buildKindGroups([
      warning({ kind: 'missing_source_reference', severity: 'needs_review', raw: 'a', nodeIds: ['n1', 'n2'] }),
    ]);
    const gateOpen = computeWriteGate(open, none);
    expect(gateOpen.blocked).toBe(true);
    expect(gateOpen.firstBlocker?.ackPolicy).toBe('kind_counted');

    const acknowledged = buildKindGroups([
      warning({ kind: 'missing_source_reference', severity: 'needs_review', raw: 'a', nodeIds: ['n1', 'n2'], acknowledged: true }),
    ]);
    expect(computeWriteGate(acknowledged, none).blocked).toBe(false);
  });

  it('an acknowledgement does not clear a per-item kind that has affected items... unless every record is acknowledged', () => {
    // Per-item kinds are cleared by item decisions. A record-level acknowledgement of the whole kind (the
    // existing "Mark handled" for kinds with no tree) still completes it, as kindProgress already says.
    const groups = buildKindGroups([
      warning({ kind: 'zero_nodes', severity: 'pipeline_issue', raw: 'z', acknowledged: false }),
    ]);
    expect(computeWriteGate(groups, none).blocked).toBe(true);
    const handled = buildKindGroups([
      warning({ kind: 'zero_nodes', severity: 'pipeline_issue', raw: 'z', acknowledged: true }),
    ]);
    expect(computeWriteGate(handled, none).blocked).toBe(false);
  });

  it('orders blockers as the groups are ordered and sums remaining across kinds', () => {
    const groups = buildKindGroups([
      warning({ kind: 'duplicate_customer_id', severity: 'needs_review', raw: 'a', nodeIds: ['n1', 'n2'] }),
      warning({ kind: 'parent_title_collision', severity: 'needs_review', raw: 'b', nodeIds: ['n3'] }),
    ]);
    const gate = computeWriteGate(groups, none);
    expect(gate.remaining).toBe(3);
    expect(gate.blockers.map((b) => b.kind)).toEqual(['duplicate_customer_id', 'parent_title_collision']);
  });

  it('is linear in the number of kinds and nodes (one pass; 20k nodes stay fast)', () => {
    const nodeIds = Array.from({ length: 20000 }, (_, i) => `n${i}`);
    const groups = buildKindGroups([warning({ kind: 'duplicate_customer_id', severity: 'needs_review', raw: 'a', nodeIds })]);
    const handled = new Set(nodeIds.slice(0, 19990));
    const started = performance.now();
    const gate = computeWriteGate(groups, handled);
    expect(performance.now() - started).toBeLessThan(200);
    expect(gate.remaining).toBe(10);
  });
});
