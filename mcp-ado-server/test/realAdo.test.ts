import { describe, it, expect, vi } from 'vitest';
import axios from 'axios';
import { resolveApiVersion } from '../src/backends/realAdo';
import type { AdoCredential } from '../src/auth/patAuth';

const credential: AdoCredential = { orgUrl: 'https://tfs.internal/tfs/Collection', pat: 'fake-pat' };

describe('resolveApiVersion', () => {
  it('returns the first ladder entry that responds 200', async () => {
    const httpClient = axios.create();
    const getSpy = vi.spyOn(httpClient, 'get').mockResolvedValueOnce({ status: 200, data: {} });

    const result = await resolveApiVersion(credential.orgUrl, ['7.1', '5.1', 'none'], credential, httpClient);

    expect(result).toBe('7.1');
    expect(getSpy).toHaveBeenCalledTimes(1);
    expect(getSpy.mock.calls[0][0]).toContain('api-version=7.1');
  });

  it('falls back to the second ladder entry when the first returns 404', async () => {
    const httpClient = axios.create();
    const getSpy = vi
      .spyOn(httpClient, 'get')
      .mockRejectedValueOnce({ response: { status: 404 } })
      .mockResolvedValueOnce({ status: 200, data: {} });

    const result = await resolveApiVersion(credential.orgUrl, ['7.1', '5.1', 'none'], credential, httpClient);

    expect(result).toBe('5.1');
    expect(getSpy).toHaveBeenCalledTimes(2);
  });

  it('falls back to "none" (omits the query param) when both versions 404', async () => {
    const httpClient = axios.create();
    const getSpy = vi
      .spyOn(httpClient, 'get')
      .mockRejectedValueOnce({ response: { status: 404 } })
      .mockRejectedValueOnce({ response: { status: 404 } })
      .mockResolvedValueOnce({ status: 200, data: {} });

    const result = await resolveApiVersion(credential.orgUrl, ['7.1', '5.1', 'none'], credential, httpClient);

    expect(result).toBe('none');
    expect(getSpy.mock.calls[2][0]).not.toContain('api-version');
  });

  it('throws if every ladder entry fails', async () => {
    const httpClient = axios.create();
    vi.spyOn(httpClient, 'get').mockRejectedValue({ response: { status: 404 } });

    await expect(resolveApiVersion(credential.orgUrl, ['7.1', '5.1', 'none'], credential, httpClient)).rejects.toThrow(
      /no api-version/i,
    );
  });

  it('sends the PAT as a Basic auth header on every probe', async () => {
    const httpClient = axios.create();
    const getSpy = vi.spyOn(httpClient, 'get').mockResolvedValueOnce({ status: 200, data: {} });

    await resolveApiVersion(credential.orgUrl, ['7.1'], credential, httpClient);

    const expectedHeader = `Basic ${Buffer.from(':fake-pat').toString('base64')}`;
    expect(getSpy.mock.calls[0][1]?.headers?.Authorization).toBe(expectedHeader);
  });
});
