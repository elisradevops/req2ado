export function formatSharePointExpiry(seconds: number | null): string | null {
  if (seconds === null) return null;
  if (seconds <= 0) return 'expired';
  const minutes = Math.round(seconds / 60);
  if (minutes < 1) return 'expires in under a minute';
  // "897 minutes" is not a number anyone reads: past an hour it is said in hours (DESIGN.md §4, prose durations).
  if (minutes >= 60) return `expires in about ${Math.round(minutes / 60)} h`;
  return `expires in ${minutes} minute${minutes === 1 ? '' : 's'}`;
}
