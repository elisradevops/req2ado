import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { initialsOf, serverOf, shortHandle } from '../utils/identity';
import { Button } from '../ui/Button';

// Who is signed in, as ADO knows them. The descriptor that keys everything (jobs, the knowledge base) is a long technical string, so it
// stays behind a disclosure, shown as a short handle with a way to copy the whole thing for whoever has to look it up.

interface Props {
  displayName: string | null;
  email: string | null;
  accountName: string | null;
  userId: string | null;
  orgUrl: string | null;
}

function Field({ label, children }: { label: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-ink-3">{label}</dt>
      <dd className="min-w-0 break-words text-sm text-ink-1">{children}</dd>
    </div>
  );
}

const UNKNOWN = '—';

export function ProfileCard({ displayName, email, accountName, userId, orgUrl }: Props): React.ReactElement {
  const [showId, setShowId] = useState(false);
  const [copied, setCopied] = useState(false);
  const server = serverOf(orgUrl);

  async function copy(): Promise<void> {
    if (!userId) return;
    try {
      await navigator.clipboard.writeText(userId);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <span aria-hidden="true" className="grid h-11 w-11 flex-none place-items-center rounded-full bg-accent-soft text-sm font-semibold text-accent-ink">
          {initialsOf(displayName)}
        </span>
        <p className="min-w-0 text-base font-semibold text-ink-1">
          <bdi dir="auto">{displayName}</bdi>
        </p>
      </div>
      <dl className="flex flex-col gap-3">
        <Field label="E-mail">{email ?? UNKNOWN}</Field>
        <Field label="Account">{accountName ?? UNKNOWN}</Field>
        <Field label="Server">
          {server ? (
            <span className="flex flex-col">
              <span>{server.host}</span>
              {server.collection && <span className="text-xs text-ink-3">{server.collection}</span>}
            </span>
          ) : (
            UNKNOWN
          )}
        </Field>
      </dl>
      {!email && !accountName && <p className="text-xs text-ink-3">Sign in again to show your e-mail and account.</p>}
      <div className="border-t border-hairline pt-3">
        <button
          type="button"
          onClick={() => setShowId((previous) => !previous)}
          aria-expanded={showId}
          className="flex items-center gap-1.5 text-xs font-medium text-ink-2 hover:text-ink-1"
        >
          <ChevronRight className={showId ? 'h-3.5 w-3.5 rotate-90' : 'h-3.5 w-3.5'} aria-hidden="true" />
          Technical ID
        </button>
        {showId && userId && (
          <div role="region" aria-label="Technical ID" className="mt-2 flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs text-ink-2">{shortHandle(userId)}</span>
            <Button size="sm" variant="outline" onClick={() => void copy()}>
              Copy full ID
            </Button>
            {copied && <span role="status" className="text-xs text-ok-ink">Copied</span>}
          </div>
        )}
      </div>
    </div>
  );
}
