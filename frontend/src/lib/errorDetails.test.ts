import { AxiosError, type InternalAxiosRequestConfig } from 'axios';
import { describe, expect, it } from 'vitest';
import { getServerMessage, redact, toErrorDetails } from './errorDetails';

function axiosError(status: number, data: unknown, requestData?: unknown): AxiosError {
  const config = { url: '/jobs/1/diff/a/rescore', baseURL: 'http://api', method: 'post', data: requestData } as InternalAxiosRequestConfig;
  return new AxiosError('Request failed', 'ERR_BAD_RESPONSE', config, {}, { status, data, statusText: '', headers: {}, config });
}

describe('redact', () => {
  it('masks sensitive keys at any depth but keeps path/pattern', () => {
    expect(redact({ pat: 'x', azurePat: 'x', token: 'x', nested: { Authorization: 'x', path: '/a', pattern: 'p' } })).toEqual({
      pat: '[redacted]',
      azurePat: '[redacted]',
      token: '[redacted]',
      nested: { Authorization: '[redacted]', path: '/a', pattern: 'p' },
    });
  });

  it('truncates very long strings', () => {
    expect((redact('a'.repeat(5000)) as string).length).toBeLessThan(2100);
  });
});

describe('toErrorDetails', () => {
  it('extracts status, method, url, redacted input and server stack from an axios error', () => {
    const err = axiosError(502, { message: 'Rescore failed', stack: 'at x', upstreamTraceback: 'py tb', extra: 1 }, JSON.stringify({ description: 'd', pat: 'secret' }));
    const details = toErrorDetails(err);
    expect(details.message).toBe('Rescore failed');
    expect(details.status).toBe(502);
    expect(details.method).toBe('POST');
    expect(details.url).toBe('http://api/jobs/1/diff/a/rescore');
    expect(details.requestBody).toEqual({ description: 'd', pat: '[redacted]' });
    expect(details.responseBody).toEqual({ message: 'Rescore failed', extra: 1 });
    expect(details.serverStack).toContain('at x');
    expect(details.serverStack).toContain('py tb');
  });

  it('handles plain errors and strings', () => {
    expect(toErrorDetails(new Error('boom')).message).toBe('boom');
    expect(toErrorDetails('nope').message).toBe('nope');
  });
});

describe('getServerMessage', () => {
  it('returns the server message, joining arrays, and null without a response', () => {
    expect(getServerMessage(axiosError(400, { message: ['a', 'b'] }))).toBe('a; b');
    expect(getServerMessage(new Error('x'))).toBeNull();
  });
});
