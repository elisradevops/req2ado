import { describe, it, expect } from 'vitest';
import { SEED_LINK_TYPES } from '../src/domain/adoLinkTypes';

describe('SEED_LINK_TYPES', () => {
  it('includes the built-in hierarchy, related, and affects pair with semantic hints', () => {
    const byRef = new Map(SEED_LINK_TYPES.map((t) => [t.referenceName, t]));
    expect(byRef.get('System.LinkTypes.Hierarchy-Reverse')?.name).toBe('Parent');
    expect(byRef.get('System.LinkTypes.Affects-Forward')?.name).toBe('Affects');
    expect(byRef.get('System.LinkTypes.Affects-Reverse')?.name).toBe('Affected By');
    expect(byRef.get('System.LinkTypes.Affects-Forward')?.semanticHint).toMatch(/affects the target/);
  });

  it('every entry has a non-empty referenceName and name', () => {
    for (const t of SEED_LINK_TYPES) {
      expect(t.referenceName.length).toBeGreaterThan(0);
      expect(t.name.length).toBeGreaterThan(0);
    }
  });
});
