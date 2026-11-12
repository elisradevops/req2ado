import type { AdoStatus } from '../api/ado';
import type { SharePointStatus } from '../api/kb';
import type { LlmStatus } from '../api/llm';
import type { StatusEntry } from '../store/connectionStatusStore';
import { formatSharePointExpiry } from './sharePointStatus';

// What "is Azure DevOps / SharePoint / the LLM backend usable" means for the person looking, in words. One place decides how each
// answer is worded and how serious it is, so the rail, the status popover and Settings cannot disagree: a credential that was
// rejected is danger, a service that cannot be reached is a warning, and a connection nobody set up is neither.

export interface ConnectionEntries {
  ado: StatusEntry<AdoStatus>;
  sharePoint: StatusEntry<SharePointStatus>;
  llm: StatusEntry<LlmStatus>;
}

export type ConnectionKind = keyof ConnectionEntries;
export type HealthState = 'checking' | 'ok' | 'attention' | 'danger' | 'off';

export interface ConnectionRow {
  kind: ConnectionKind;
  label: string;
  state: HealthState;
  // What to say about it, e.g. "Connected, 42ms".
  word: string;
  checkedAt: number | null;
}

export interface ConnectionSummary {
  state: 'checking' | 'ok' | 'attention';
  attentionCount: number;
  label: string;
}

const CHECKING = 'Checking…';

export function adoConnectionRow(entry: StatusEntry<AdoStatus>): ConnectionRow {
  const base = { kind: 'ado' as const, label: 'Azure DevOps', checkedAt: entry.checkedAt };
  if (entry.error) return { ...base, state: 'attention', word: "Can't reach Azure DevOps" };
  switch (entry.data?.status) {
    case 'valid':
      return { ...base, state: 'ok', word: 'Connected' };
    case 'invalid':
      return { ...base, state: 'danger', word: 'Token rejected' };
    case 'not_configured':
      return { ...base, state: 'off', word: 'Not configured' };
    case 'unreachable':
      return { ...base, state: 'attention', word: "Can't reach Azure DevOps" };
    default:
      return { ...base, state: 'checking', word: CHECKING };
  }
}

function sharePointRow(entry: StatusEntry<SharePointStatus>): ConnectionRow {
  const base = { kind: 'sharePoint' as const, label: 'SharePoint', checkedAt: entry.checkedAt };
  if (entry.error) return { ...base, state: 'attention', word: "Can't reach Microsoft Graph" };
  const data = entry.data;
  switch (data?.status) {
    case 'valid': {
      const expiry = formatSharePointExpiry(data.expiresInSeconds);
      return { ...base, state: 'ok', word: expiry ? `Connected, ${expiry}` : 'Connected' };
    }
    case 'invalid':
      return { ...base, state: 'danger', word: 'Token invalid' };
    case 'unreachable':
      return { ...base, state: 'attention', word: "Can't reach Microsoft Graph" };
    case 'not_configured':
      return { ...base, state: 'off', word: 'Not configured' };
    default:
      return { ...base, state: 'checking', word: CHECKING };
  }
}

function llmRow(entry: StatusEntry<LlmStatus>): ConnectionRow {
  const base = { kind: 'llm' as const, label: 'LLM Backend', checkedAt: entry.checkedAt };
  if (entry.error) return { ...base, state: 'attention', word: "Can't reach the LLM backend" };
  const data = entry.data;
  switch (data?.status) {
    case 'reachable':
      return { ...base, state: 'ok', word: data.latencyMs !== null ? `Connected, ${data.latencyMs}ms` : 'Connected' };
    case 'unreachable':
      return { ...base, state: 'attention', word: "Can't reach the LLM backend" };
    case 'not_configured':
      return { ...base, state: 'off', word: 'Not configured' };
    default:
      return { ...base, state: 'checking', word: CHECKING };
  }
}

export function connectionRows(entries: ConnectionEntries): ConnectionRow[] {
  return [adoConnectionRow(entries.ado), sharePointRow(entries.sharePoint), llmRow(entries.llm)];
}

export function summarizeConnections(rows: ConnectionRow[]): ConnectionSummary {
  const attentionCount = rows.filter((row) => row.state === 'attention' || row.state === 'danger').length;
  if (attentionCount > 0) return { state: 'attention', attentionCount, label: `${attentionCount} ${attentionCount === 1 ? 'needs' : 'need'} attention` };
  if (rows.some((row) => row.state === 'checking')) return { state: 'checking', attentionCount: 0, label: 'Checking connections…' };
  return { state: 'ok', attentionCount: 0, label: 'All systems OK' };
}
