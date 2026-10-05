import axios from 'axios';

export interface ErrorDetails {
  message: string;
  status?: number;
  method?: string;
  url?: string;
  // Redacted request payload (the "input" of the failed call).
  requestBody?: unknown;
  // Redacted response payload, minus fields surfaced separately below.
  responseBody?: unknown;
  // Browser-side stack of the caught error.
  stack?: string;
  // Server stack (orchestrator `stack`, ingestion `traceback`); only present
  // when the backend runs with EXPOSE_ERROR_DETAILS on.
  serverStack?: string;
  timestamp: string;
}

const REDACTED = '[redacted]';
const MAX_STRING_CHARS = 2000;
const MAX_DEPTH = 6;

const SENSITIVE_KEY = /token|secret|password|passwd|authorization|cookie|api[-_]?key|bearer|credential/i;

// 'pat' needs its own check: a bare /pat/i would also redact "path"/"pattern".
function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key) || /^pat($|[-_])/i.test(key) || /[-_]pat$/i.test(key) || /[a-z]Pat$/.test(key);
}

export function redact(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    return value.length > MAX_STRING_CHARS ? `${value.slice(0, MAX_STRING_CHARS)}… [truncated ${value.length - MAX_STRING_CHARS} chars]` : value;
  }
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[nested]';
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSensitiveKey(key) ? REDACTED : redact(entry, depth + 1);
  }
  return out;
}

function describeRequestData(data: unknown): unknown {
  if (data === undefined || data === null || data === '') return undefined;
  if (typeof FormData !== 'undefined' && data instanceof FormData) {
    // Never dump file contents -- just name the parts.
    const parts: Record<string, unknown> = {};
    data.forEach((entry, key) => {
      parts[key] =
        typeof entry === 'string' ? entry : `[file ${entry.name}, ${entry.size} bytes]`;
    });
    return redact(parts);
  }
  if (typeof data === 'string') {
    try {
      return redact(JSON.parse(data));
    } catch {
      return redact(data);
    }
  }
  return redact(data);
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
    if (Array.isArray(value) && value.length > 0) return value.map(String).join('; ');
  }
  return undefined;
}

/** The server's own human-readable explanation, when the failure was an HTTP
 * error response carrying one (NestJS `message`, FastAPI `detail`, chat
 * `reason`). Null for network errors or bodies without a usable message. */
export function getServerMessage(err: unknown): string | null {
  if (!axios.isAxiosError(err) || !err.response) return null;
  const data = err.response.data as Record<string, unknown> | string | undefined;
  if (typeof data === 'string') return data.length > 0 && data.length <= 300 ? data : null;
  return firstString(data?.message, data?.detail, data?.reason) ?? null;
}

function isErrorDetails(value: unknown): value is ErrorDetails {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ErrorDetails).message === 'string' &&
    typeof (value as ErrorDetails).timestamp === 'string' &&
    !(value instanceof Error)
  );
}

export function toErrorDetails(err: unknown): ErrorDetails {
  if (isErrorDetails(err)) return err;
  const timestamp = new Date().toISOString();
  if (axios.isAxiosError(err)) {
    const data = err.response?.data;
    const record = data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
    const { stack: serverStack, upstreamTraceback, traceback, ...restOfBody } = record ?? {};
    const base = err.config?.baseURL ?? '';
    const path = err.config?.url ?? '';
    return {
      message: getServerMessage(err) ?? err.message,
      status: err.response?.status,
      method: err.config?.method?.toUpperCase(),
      url: path.startsWith('http') ? path : `${base}${path}`,
      requestBody: describeRequestData(err.config?.data),
      responseBody: record ? redact(restOfBody) : redact(data),
      stack: err.stack,
      serverStack:
        [firstString(serverStack), firstString(upstreamTraceback, traceback)].filter(Boolean).join('\n\n--- upstream ---\n') ||
        undefined,
      timestamp,
    };
  }
  if (err instanceof Error) return { message: err.message, stack: err.stack, timestamp };
  return { message: typeof err === 'string' ? err : 'Unknown error', timestamp };
}

/** Plain-text rendering for the dialog's "Copy details" button. */
export function formatErrorDetails(details: ErrorDetails): string {
  const lines: string[] = [`Message: ${details.message}`];
  if (details.status !== undefined) lines.push(`Status: ${details.status}`);
  if (details.method || details.url) lines.push(`Request: ${[details.method, details.url].filter(Boolean).join(' ')}`);
  lines.push(`Time: ${details.timestamp}`);
  if (details.requestBody !== undefined) lines.push('', 'Input (redacted):', JSON.stringify(details.requestBody, null, 2));
  if (details.responseBody !== undefined) lines.push('', 'Response:', JSON.stringify(details.responseBody, null, 2));
  if (details.stack) lines.push('', 'Stack:', details.stack);
  if (details.serverStack) lines.push('', 'Server stack:', details.serverStack);
  return lines.join('\n');
}
