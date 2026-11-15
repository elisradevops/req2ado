import { describe, it, expect } from 'vitest';
import { findPreviousRuns } from './previousRuns';

const job = (id: string, name: string, createdAt: string, status = 'diff_ready') => ({ id, originalFilename: name, createdAt, status });

describe('findPreviousRuns', () => {
  it('finds earlier jobs of a file with the same name, newest first, and counts the others', () => {
    const result = findPreviousRuns(
      [
        job('a', 'spec.docx', '2026-11-10T10:00:00Z'),
        job('b', 'other.docx', '2026-11-12T10:00:00Z'),
        job('c', 'spec.docx', '2026-11-12T08:00:00Z', 'succeeded'),
        job('d', 'spec.docx', '2026-11-11T08:00:00Z'),
      ],
      'spec.docx',
    );
    expect(result?.latest.id).toBe('c');
    expect(result?.latest.status).toBe('succeeded');
    expect(result?.others).toBe(2);
  });

  it('matches the name exactly apart from letter case, never a part of it', () => {
    expect(findPreviousRuns([job('a', 'Spec.DOCX', '2026-11-10T10:00:00Z')], 'spec.docx')?.latest.id).toBe('a');
    expect(findPreviousRuns([job('a', 'spec.docx.bak', '2026-11-10T10:00:00Z'), job('b', 'my spec.docx', '2026-11-10T10:00:00Z')], 'spec.docx')).toBeNull();
  });

  it('is null when there is no earlier run, or nothing usable to look through', () => {
    expect(findPreviousRuns([], 'spec.docx')).toBeNull();
    expect(findPreviousRuns(undefined, 'spec.docx')).toBeNull();
    expect(findPreviousRuns([job('a', 'spec.docx', '2026-11-10T10:00:00Z')], '')).toBeNull();
  });

  it('ignores a job with an unreadable date when ordering, rather than failing', () => {
    expect(findPreviousRuns([job('a', 'spec.docx', 'nonsense'), job('b', 'spec.docx', '2026-11-10T10:00:00Z')], 'spec.docx')?.latest.id).toBe('b');
  });

  it('scans 50,000 jobs in well under a second (one pass)', () => {
    const many = Array.from({ length: 50000 }, (_, i) => job(`j${i}`, i % 1000 === 0 ? 'spec.docx' : `f${i}.docx`, new Date(2026, 0, 1, 0, 0, i % 60).toISOString()));
    const started = performance.now();
    const result = findPreviousRuns(many, 'spec.docx');
    expect(performance.now() - started).toBeLessThan(1000);
    expect(result?.others).toBe(49);
  });
});
