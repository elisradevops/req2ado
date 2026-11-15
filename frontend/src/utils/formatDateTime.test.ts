import { describe, it, expect } from 'vitest';
import { formatDate, formatDateTime } from './formatDateTime';

// DESIGN.md §4: one format for an absolute date and time, whatever the browser's locale (it had seven: 11/12/2026, 5:53:21 PM, ...).
describe('formatDateTime', () => {
  const local = new Date(2026, 10, 12, 17, 5, 9); // 12 Nov 2026 17:05:09 in the viewer's own time zone

  it('writes day, short month, year and a 24-hour time without seconds', () => {
    expect(formatDateTime(local)).toBe('12 Nov 2026, 17:05');
  });

  it('pads the hour and minute, and keeps midnight as 00:00', () => {
    expect(formatDateTime(new Date(2026, 0, 3, 0, 7))).toBe('3 Jan 2026, 00:07');
  });

  it('accepts an ISO string or a timestamp as well as a Date', () => {
    expect(formatDateTime(local.toISOString())).toBe('12 Nov 2026, 17:05');
    expect(formatDateTime(local.getTime())).toBe('12 Nov 2026, 17:05');
  });

  it('says "--" for a missing or invalid value, never "Invalid Date" or a zero date (DESIGN.md §16.23)', () => {
    expect(formatDateTime(null)).toBe('--');
    expect(formatDateTime(undefined)).toBe('--');
    expect(formatDateTime('not a date')).toBe('--');
  });
});

describe('formatDate', () => {
  it('is the date part alone', () => {
    expect(formatDate(new Date(2026, 10, 12, 17, 5))).toBe('12 Nov 2026');
    expect(formatDate(undefined)).toBe('--');
  });
});
