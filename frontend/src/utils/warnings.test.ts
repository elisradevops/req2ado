import { describe, it, expect } from 'vitest';
import { normalizeWarning, type WarningRecord } from './warnings';

describe('normalizeWarning', () => {
  it('passes a real WarningRecord through unchanged', () => {
    const record: WarningRecord = {
      kind: 'reparented_to_feature',
      severity: 'auto_fixed',
      nodeIds: ['n0'],
      detail: { targetFeatureId: 'f0' },
      raw: '1 Requirement(s) were re-parented under Feature f0.',
    };
    expect(normalizeWarning(record)).toBe(record);
  });

  it('classifies a legacy dropped-block string, tagging it as legacy and needs_review', () => {
    const raw = 'SURVEY analysis did not reference 2 of 5 source block(s), and their content does not appear (even paraphrased) in any generated node -- likely dropped, not merged: [1, 2]';
    const result = normalizeWarning(raw);
    expect(result).toEqual({ kind: 'dropped_blocks', severity: 'needs_review', nodeIds: [], detail: {}, raw, legacy: true });
  });

  it('classifies a legacy external-reference string', () => {
    const raw = "Section br0_ references an external artifact ('ReqID') this SURVEY run did not ingest -- consider adding it to the knowledge base.";
    const result = normalizeWarning(raw);
    expect(result.kind).toBe('external_reference');
    expect(result.severity).toBe('needs_review');
    expect(result.legacy).toBe(true);
  });

  it('classifies a legacy near-duplicate-conflict string and extracts its nodeIds', () => {
    const raw = "Near-duplicate items 'Power supply efficiency' [localId: n0], 'Power supply efficiency (appendix)' [localId: n1] appear to state conflicting values for the same parameter (['85%', '93%']) -- resolve before this can be finalized.";
    const result = normalizeWarning(raw);
    expect(result.kind).toBe('near_duplicate_conflict');
    expect(result.nodeIds).toEqual(['n0', 'n1']);
  });

  it('falls back an unrecognized legacy string to kind "other" and severity needs_review, never auto_fixed', () => {
    const result = normalizeWarning('Some future message this frontend has never seen before.');
    expect(result.kind).toBe('other');
    expect(result.severity).toBe('needs_review');
    expect(result.legacy).toBe(true);
  });
});
