import { describe, it, expect, vi } from 'vitest';
import axios from 'axios';
import { resolveApiVersion, RealAdoBackend } from '../src/backends/realAdo';
import type { AdoCredential } from '../src/auth/patAuth';
import type { AdoMcpConfig } from '../src/config/env';

const credential: AdoCredential = { orgUrl: 'https://tfs.internal/tfs/Collection', pat: 'fake-pat' };

const testConfig: AdoMcpConfig = {
  adoBaseUrl: 'https://tfs.internal/tfs/Collection',
  adoProject: 'MyProject',
  apiVersionLadder: ['7.1'],
  batchSize: 200,
  concurrency: 8,
  mcpBearer: 'test-bearer',
  port: 0,
  backend: 'real',
  mockDbPath: '',
};

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

describe('RealAdoBackend.createWorkItem', () => {
  it('POSTs a JSON-Patch body to the correct work-item-type endpoint', async () => {
    const backend = new RealAdoBackend(testConfig, credential);
    const httpClient = axios.create();
    vi.spyOn(httpClient, 'get').mockResolvedValueOnce({ status: 200, data: {} }); // api-version probe
    const postSpy = vi.spyOn(httpClient, 'post').mockResolvedValueOnce({
      status: 200,
      data: { id: 42, fields: { 'System.Title': 'Test req' } },
    });
    // @ts-expect-error -- injecting the spied client for the test
    backend.httpClient = httpClient;

    const result = await backend.createWorkItem({ type: 'Requirement', fields: { 'System.Title': 'Test req' } });

    expect(result.id).toBe(42);
    expect(result.type).toBe('Requirement');
    expect(postSpy.mock.calls[0][0]).toContain('/wit/workitems/$Requirement');
    expect(postSpy.mock.calls[0][1]).toEqual([{ op: 'add', path: '/fields/System.Title', value: 'Test req' }]);
    expect(postSpy.mock.calls[0][2]?.headers?.['Content-Type']).toBe('application/json-patch+json');
  });

  it('sets parentId to null on a newly created item with no parent field', async () => {
    const backend = new RealAdoBackend(testConfig, credential);
    const httpClient = axios.create();
    vi.spyOn(httpClient, 'get').mockResolvedValueOnce({ status: 200, data: {} });
    vi.spyOn(httpClient, 'post').mockResolvedValueOnce({ status: 200, data: { id: 1, fields: {} } });
    // @ts-expect-error -- injecting the spied client
    backend.httpClient = httpClient;

    const result = await backend.createWorkItem({ type: 'Epic', fields: {} });
    expect(result.parentId).toBeNull();
  });
});

describe('RealAdoBackend.getWorkItem', () => {
  it('GETs the work item by id and maps the response', async () => {
    const backend = new RealAdoBackend(testConfig, credential);
    const httpClient = axios.create();
    vi.spyOn(httpClient, 'get')
      .mockResolvedValueOnce({ status: 200, data: {} }) // api-version probe
      .mockResolvedValueOnce({
        status: 200,
        data: {
          id: 42,
          fields: { 'System.WorkItemType': 'Requirement', 'System.Title': 'Test req' },
          relations: [],
        },
      });
    // @ts-expect-error -- injecting the spied client
    backend.httpClient = httpClient;

    const result = await backend.getWorkItem(42);
    expect(result).not.toBeNull();
    expect(result?.id).toBe(42);
    expect(result?.type).toBe('Requirement');
  });

  it('returns null on a 404', async () => {
    const backend = new RealAdoBackend(testConfig, credential);
    const httpClient = axios.create();
    vi.spyOn(httpClient, 'get')
      .mockResolvedValueOnce({ status: 200, data: {} })
      .mockRejectedValueOnce({ response: { status: 404 } });
    // @ts-expect-error -- injecting the spied client
    backend.httpClient = httpClient;

    const result = await backend.getWorkItem(9999);
    expect(result).toBeNull();
  });

  it('extracts parentId from a Hierarchy-Reverse relation when present', async () => {
    const backend = new RealAdoBackend(testConfig, credential);
    const httpClient = axios.create();
    vi.spyOn(httpClient, 'get')
      .mockResolvedValueOnce({ status: 200, data: {} })
      .mockResolvedValueOnce({
        status: 200,
        data: {
          id: 42,
          fields: { 'System.WorkItemType': 'Requirement' },
          relations: [
            {
              rel: 'System.LinkTypes.Hierarchy-Reverse',
              url: 'https://tfs.internal/tfs/Collection/_apis/wit/workItems/7',
            },
          ],
        },
      });
    // @ts-expect-error -- injecting the spied client
    backend.httpClient = httpClient;

    const result = await backend.getWorkItem(42);
    expect(result?.parentId).toBe(7);
  });
});

describe('RealAdoBackend.linkParentChild', () => {
  it('PATCHes a Hierarchy-Reverse relation add op onto the child work item', async () => {
    const backend = new RealAdoBackend(testConfig, credential);
    const httpClient = axios.create();
    vi.spyOn(httpClient, 'get').mockResolvedValueOnce({ status: 200, data: {} });
    const patchSpy = vi.spyOn(httpClient, 'patch').mockResolvedValueOnce({ status: 200, data: {} });
    // @ts-expect-error -- injecting the spied client
    backend.httpClient = httpClient;

    await backend.linkParentChild(42, 7);

    expect(patchSpy.mock.calls[0][0]).toContain('/wit/workitems/42');
    expect(patchSpy.mock.calls[0][1]).toEqual([
      {
        op: 'add',
        path: '/relations/-',
        value: {
          rel: 'System.LinkTypes.Hierarchy-Reverse',
          url: expect.stringContaining('/workItems/7'),
        },
      },
    ]);
  });

  it('retries on a 429 before succeeding', async () => {
    const backend = new RealAdoBackend(testConfig, credential);
    const httpClient = axios.create();
    vi.spyOn(httpClient, 'get').mockResolvedValueOnce({ status: 200, data: {} });
    const patchSpy = vi
      .spyOn(httpClient, 'patch')
      .mockRejectedValueOnce({ response: { status: 429 } })
      .mockResolvedValueOnce({ status: 200, data: {} });
    // @ts-expect-error -- injecting the spied client
    backend.httpClient = httpClient;

    await backend.linkParentChild(42, 7);
    expect(patchSpy).toHaveBeenCalledTimes(2);
  });
});

describe('RealAdoBackend.queryIds', () => {
  it('runs a WIQL query built from the field-match map and returns matching ids', async () => {
    const backend = new RealAdoBackend(testConfig, credential);
    const httpClient = axios.create();
    vi.spyOn(httpClient, 'get').mockResolvedValueOnce({ status: 200, data: {} }); // api-version probe
    const postSpy = vi.spyOn(httpClient, 'post').mockResolvedValueOnce({
      status: 200,
      data: { workItems: [{ id: 1 }, { id: 2 }] },
    });
    // @ts-expect-error -- injecting the spied client
    backend.httpClient = httpClient;

    const result = await backend.queryIds({ 'Custom.SourceHash': 'abc123' });

    expect(result).toEqual([1, 2]);
    expect(postSpy.mock.calls[0][0]).toContain('/wit/wiql');
    expect(postSpy.mock.calls[0][1].query).toContain("[Custom.SourceHash] = 'abc123'");
  });

  it('combines multiple field-match entries with AND', async () => {
    const backend = new RealAdoBackend(testConfig, credential);
    const httpClient = axios.create();
    vi.spyOn(httpClient, 'get').mockResolvedValueOnce({ status: 200, data: {} });
    const postSpy = vi.spyOn(httpClient, 'post').mockResolvedValueOnce({ status: 200, data: { workItems: [] } });
    // @ts-expect-error -- injecting the spied client
    backend.httpClient = httpClient;

    await backend.queryIds({ 'Custom.SourceHash': 'abc123', 'System.AreaPath': 'Project\\Area1' });

    const query = postSpy.mock.calls[0][1].query;
    expect(query).toContain("[Custom.SourceHash] = 'abc123'");
    expect(query).toContain("[System.AreaPath] = 'Project\\Area1'");
    expect(query).toContain(' AND ');
  });

  it('returns an empty array when nothing matches', async () => {
    const backend = new RealAdoBackend(testConfig, credential);
    const httpClient = axios.create();
    vi.spyOn(httpClient, 'get').mockResolvedValueOnce({ status: 200, data: {} });
    vi.spyOn(httpClient, 'post').mockResolvedValueOnce({ status: 200, data: { workItems: [] } });
    // @ts-expect-error -- injecting the spied client
    backend.httpClient = httpClient;

    const result = await backend.queryIds({ 'Custom.SourceHash': 'nonexistent' });
    expect(result).toEqual([]);
  });

  it('escapes single quotes in field values to prevent WIQL injection', async () => {
    const backend = new RealAdoBackend(testConfig, credential);
    const httpClient = axios.create();
    vi.spyOn(httpClient, 'get').mockResolvedValueOnce({ status: 200, data: {} });
    const postSpy = vi.spyOn(httpClient, 'post').mockResolvedValueOnce({ status: 200, data: { workItems: [] } });
    // @ts-expect-error -- injecting the spied client
    backend.httpClient = httpClient;

    await backend.queryIds({ 'System.Title': "O'Brien's spec" });
    const query = postSpy.mock.calls[0][1].query;
    expect(query).toContain("O''Brien''s spec");
  });
});

describe('RealAdoBackend.setFields', () => {
  it('PATCHes a JSON-Patch add op per field', async () => {
    const backend = new RealAdoBackend(testConfig, credential);
    const httpClient = axios.create();
    vi.spyOn(httpClient, 'get').mockResolvedValueOnce({ status: 200, data: {} });
    const patchSpy = vi.spyOn(httpClient, 'patch').mockResolvedValueOnce({ status: 200, data: {} });
    // @ts-expect-error -- injecting the spied client
    backend.httpClient = httpClient;

    await backend.setFields(42, { 'System.State': 'Active' });

    expect(patchSpy.mock.calls[0][0]).toContain('/wit/workitems/42');
    expect(patchSpy.mock.calls[0][1]).toEqual([{ op: 'add', path: '/fields/System.State', value: 'Active' }]);
  });
});

describe('RealAdoBackend.discoverFields', () => {
  it('GETs the work-item-type fields endpoint and returns the reference names', async () => {
    const backend = new RealAdoBackend(testConfig, credential);
    const httpClient = axios.create();
    vi.spyOn(httpClient, 'get')
      .mockResolvedValueOnce({ status: 200, data: {} }) // api-version probe
      .mockResolvedValueOnce({
        status: 200,
        data: {
          fields: [
            { referenceName: 'System.Title' },
            { referenceName: 'Custom.CustomerRequirementId' },
            { referenceName: 'Microsoft.VSTS.CMMI.RequirementType' },
          ],
        },
      });
    // @ts-expect-error -- injecting the spied client
    backend.httpClient = httpClient;

    const result = await backend.discoverFields('Requirement');
    expect(result).toEqual(['System.Title', 'Custom.CustomerRequirementId', 'Microsoft.VSTS.CMMI.RequirementType']);
  });
});
