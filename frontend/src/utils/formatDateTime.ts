// DESIGN.md §4: one format for an absolute date and time: "12 Nov 2026, 17:55", 24-hour, whatever the browser's locale. Dates and times
// are prose, not identifiers, so they are not set in mono (§0.1). A missing or invalid value is "--", never "Invalid Date" (§16.23).
const DATE = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const TIME = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

type DateInput = Date | string | number | null | undefined;

function toDate(value: DateInput): Date | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDate(value: DateInput): string {
  const date = toDate(value);
  return date ? DATE.format(date) : '--';
}

export function formatDateTime(value: DateInput): string {
  const date = toDate(value);
  return date ? `${DATE.format(date)}, ${TIME.format(date)}` : '--';
}
