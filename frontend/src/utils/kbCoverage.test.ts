import { describe, expect, it } from 'vitest';
import { describeJobKbCoverage, describeStepKbGrounding } from './kbCoverage';

describe('describeStepKbGrounding', () => {
  it('returns null when the number of available files is unknown', () => {
    expect(describeStepKbGrounding(undefined, 0, false)).toBeNull();
    expect(describeStepKbGrounding(null, 2, true)).toBeNull();
  });

  it('says the KB is empty when no files are available', () => {
    expect(describeStepKbGrounding(0, 0, false)).toEqual({ grounded: false, text: 'Your knowledge base has no ingested files' });
  });

  it('reports files available when nothing was cited for the step', () => {
    expect(describeStepKbGrounding(3, 0, false)).toEqual({
      grounded: false,
      text: 'Not grounded against your knowledge base for this step (3 files available)',
    });
    expect(describeStepKbGrounding(1, 0, false)?.text).toContain('(1 file available)');
  });

  it('reports cited of available when grounded', () => {
    expect(describeStepKbGrounding(3, 2, true)).toEqual({ grounded: true, text: 'Grounded against 2 of 3 KB files' });
    expect(describeStepKbGrounding(1, 1, true)?.text).toBe('Grounded against 1 of 1 KB file');
  });
});

describe('describeStepKbGrounding consistency with the grounded flag', () => {
  it('never says "Grounded against" when the step was not grounded, even with citations present', () => {
    expect(describeStepKbGrounding(3, 2, false)?.grounded).toBe(false);
    expect(describeStepKbGrounding(3, 2, false)?.text).toContain('Not grounded');
  });

  it('never prints "of 0" when a grounded step reports an empty KB', () => {
    expect(describeStepKbGrounding(0, 1, true)).toBeNull();
  });
});

describe('describeJobKbCoverage', () => {
  it('returns null for a job without coverage (BASELINE or created before the field existed)', () => {
    expect(describeJobKbCoverage(null)).toBeNull();
    expect(describeJobKbCoverage(undefined)).toBeNull();
  });

  it('treats 0 available as "no KB", not a coverage ratio', () => {
    expect(describeJobKbCoverage({ filesAvailable: 0, filesCited: 0 })).toEqual({
      tone: 'none',
      text: 'No knowledge-base files were available to this job.',
    });
  });

  it('warns when files were available but none surfaced', () => {
    expect(describeJobKbCoverage({ filesAvailable: 3, filesCited: 0 })).toEqual({
      tone: 'warning',
      text: 'None of the 3 knowledge-base files were surfaced for this job.',
    });
  });

  it('uses singular grammar when the single available file was not surfaced', () => {
    expect(describeJobKbCoverage({ filesAvailable: 1, filesCited: 0 })?.text).toBe(
      'The 1 knowledge-base file was not surfaced for this job.',
    );
  });

  it('reports surfaced of available', () => {
    expect(describeJobKbCoverage({ filesAvailable: 3, filesCited: 2 })).toEqual({
      tone: 'ok',
      text: '2 of 3 knowledge-base files were surfaced for this job.',
    });
    expect(describeJobKbCoverage({ filesAvailable: 1, filesCited: 1 })?.text).toBe(
      '1 of 1 knowledge-base file was surfaced for this job.',
    );
  });
});
