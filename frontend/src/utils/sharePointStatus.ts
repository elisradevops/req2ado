export function formatSharePointExpiry(seconds: number | null): string | null {
  if (seconds === null) return null;
  if (seconds <= 0) return 'expired';
  const minutes = Math.round(seconds / 60);
  return minutes < 1 ? 'expires in under a minute' : `expires in ${minutes} minute${minutes === 1 ? '' : 's'}`;
}
