import { describe, expect, it } from 'vitest';
import { connectionRows, summarizeConnections, type ConnectionEntries } from './connectionHealth';

const entry = <T>(data: T | null, error = false, checkedAt: number | null = 1000) => ({ data, error, checkedAt, inFlight: false });

function entries(overrides: Partial<ConnectionEntries> = {}): ConnectionEntries {
  return {
    ado: entry({ status: 'valid' as const }),
    sharePoint: entry({ status: 'valid' as const, expiresInSeconds: 2820 }),
    llm: entry({ status: 'reachable' as const, latencyMs: 42 }),
    ...overrides,
  };
}

const row = (all: ConnectionEntries, kind: string) => connectionRows(all).find((r) => r.kind === kind)!;

describe('connectionRows', () => {
  it('says what is connected, in words, with the detail that matters for each', () => {
    const rows = connectionRows(entries());

    expect(rows.map((r) => [r.label, r.state, r.word])).toEqual([
      ['Azure DevOps', 'ok', 'Connected'],
      ['SharePoint', 'ok', 'Connected, expires in 47 minutes'],
      ['LLM Backend', 'ok', 'Connected, 42ms'],
    ]);
  });

  it('keeps when each was last checked', () => {
    expect(connectionRows(entries({ llm: entry({ status: 'reachable' as const, latencyMs: 1 }, false, 5555) })).find((r) => r.kind === 'llm')!.checkedAt).toBe(5555);
  });

  describe('severity', () => {
    it('a rejected credential is danger, and unreachable is a warning, for every connection', () => {
      expect(row(entries({ sharePoint: entry({ status: 'invalid' as const, expiresInSeconds: null }) }), 'sharePoint')).toMatchObject({ state: 'danger', word: 'Token invalid' });
      expect(row(entries({ sharePoint: entry({ status: 'unreachable' as const, expiresInSeconds: null }) }), 'sharePoint')).toMatchObject({ state: 'attention', word: "Can't reach Microsoft Graph" });
      expect(row(entries({ ado: entry({ status: 'unreachable' as const }) }), 'ado')).toMatchObject({ state: 'attention', word: "Can't reach Azure DevOps" });
      expect(row(entries({ llm: entry({ status: 'unreachable' as const, latencyMs: null }) }), 'llm')).toMatchObject({ state: 'attention', word: "Can't reach the LLM backend" });
    });

    it('a check that could not be completed reads as unreachable, whatever was known before', () => {
      expect(row(entries({ ado: entry({ status: 'valid' as const }, true) }), 'ado')).toMatchObject({ state: 'attention' });
    });

    it('not set up is its own state, not a fault', () => {
      expect(row(entries({ sharePoint: entry({ status: 'not_configured' as const, expiresInSeconds: null }) }), 'sharePoint')).toMatchObject({ state: 'off', word: 'Not configured' });
    });

    it('is checking until the first answer', () => {
      expect(row(entries({ llm: entry(null, false, null) }), 'llm')).toMatchObject({ state: 'checking', word: 'Checking…' });
    });
  });
});

describe('summarizeConnections', () => {
  it('says all is well when every connection is', () => {
    expect(summarizeConnections(connectionRows(entries()))).toEqual({ state: 'ok', attentionCount: 0, label: 'All systems OK' });
  });

  it('counts what needs attention, with the right grammar', () => {
    const one = summarizeConnections(connectionRows(entries({ ado: entry({ status: 'unreachable' as const }) })));
    expect(one).toEqual({ state: 'attention', attentionCount: 1, label: '1 needs attention' });

    const two = summarizeConnections(connectionRows(entries({ ado: entry({ status: 'unreachable' as const }), sharePoint: entry({ status: 'invalid' as const, expiresInSeconds: null }) })));
    expect(two).toEqual({ state: 'attention', attentionCount: 2, label: '2 need attention' });
  });

  it('does not count a connection that is not set up as a fault', () => {
    expect(summarizeConnections(connectionRows(entries({ sharePoint: entry({ status: 'not_configured' as const, expiresInSeconds: null }) }))).state).toBe('ok');
  });

  it('is checking while the first answers are on their way, but a known fault is not hidden by it', () => {
    expect(summarizeConnections(connectionRows(entries({ llm: entry(null, false, null) })))).toEqual({ state: 'checking', attentionCount: 0, label: 'Checking connections…' });
    expect(summarizeConnections(connectionRows(entries({ llm: entry(null, false, null), ado: entry({ status: 'unreachable' as const }) }))).state).toBe('attention');
  });
});
