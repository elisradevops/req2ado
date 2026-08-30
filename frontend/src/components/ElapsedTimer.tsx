import { useNow } from '../hooks/useNow';

function formatElapsed(ms: number): string {
  // An unparseable startedAt (new Date(...).getTime() -> NaN) previously
  // rendered the literal string "NaN:NaN" -- Math.floor/toString/padStart
  // all pass a NaN straight through without ever throwing.
  if (!Number.isFinite(ms)) return '00:00';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number): string => n.toString().padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

export function ElapsedTimer({ startedAt }: { startedAt: string }): React.ReactElement {
  const now = useNow();
  return <span className="font-mono tabular-nums">{formatElapsed(now - new Date(startedAt).getTime())}</span>;
}
