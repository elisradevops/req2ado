import { describe, it, expect } from 'vitest';
import { plural } from './plural';

describe('plural', () => {
  it('says one of something in the singular and everything else in the plural, with the count first', () => {
    expect(plural(1, 'figure')).toBe('1 figure');
    expect(plural(0, 'figure')).toBe('0 figures');
    expect(plural(2, 'figure')).toBe('2 figures');
  });

  it('takes an irregular plural and groups thousands', () => {
    expect(plural(2, 'quality issue')).toBe('2 quality issues');
    expect(plural(1, 'entry', 'entries')).toBe('1 entry');
    expect(plural(3, 'entry', 'entries')).toBe('3 entries');
    expect(plural(1200, 'item')).toBe('1,200 items');
  });
});
