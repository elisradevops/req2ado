import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { formatErrorDetails, type ErrorDetails } from '../lib/errorDetails';

function Section({ label, children }: { label: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-semibold text-ink-2">{label}</span>
      {children}
    </div>
  );
}

function Mono({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-sm border border-hairline bg-surface-alt p-2 font-mono text-xs text-ink-1">
      {children}
    </pre>
  );
}

function json(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

export function ErrorDetailsDialog({
  details,
  onClose,
}: {
  details: ErrorDetails | null;
  onClose: () => void;
}): React.ReactElement {
  const [copied, setCopied] = useState(false);

  async function copy(): Promise<void> {
    if (!details) return;
    try {
      await navigator.clipboard.writeText(formatErrorDetails(details));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard can be blocked (insecure context / permissions); the text
      // stays selectable in the dialog, so there is nothing else to do.
    }
  }

  return (
    <Dialog
      open={details !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Error details"
      description="Share these details when reporting a problem. Tokens and passwords are redacted."
      maxWidthClassName="max-w-[640px]"
      footer={
        <>
          <Button variant="outline" size="sm" onClick={() => void copy()}>
            {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
            {copied ? 'Copied' : 'Copy details'}
          </Button>
          <Button size="sm" onClick={onClose} className="ml-auto">
            Close
          </Button>
        </>
      }
    >
      {details && (
        <div className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto pb-2">
          <Section label="Message">
            <p className="text-sm text-ink-1">{details.message}</p>
          </Section>
          {details.status !== undefined && (
            <Section label="Status">
              <span className="font-mono text-sm text-ink-1">{details.status}</span>
            </Section>
          )}
          {(details.method || details.url) && (
            <Section label="Request">
              <span className="break-all font-mono text-xs text-ink-1">{[details.method, details.url].filter(Boolean).join(' ')}</span>
            </Section>
          )}
          {details.requestBody !== undefined && (
            <Section label="Input (redacted)">
              <Mono>{json(details.requestBody)}</Mono>
            </Section>
          )}
          {details.responseBody !== undefined && (
            <Section label="Response">
              <Mono>{json(details.responseBody)}</Mono>
            </Section>
          )}
          {details.stack && (
            <Section label="Stack (browser)">
              <Mono>{details.stack}</Mono>
            </Section>
          )}
          {details.serverStack && (
            <Section label="Stack (server)">
              <Mono>{details.serverStack}</Mono>
            </Section>
          )}
          <span className="text-xs text-ink-3">{details.timestamp}</span>
        </div>
      )}
    </Dialog>
  );
}
