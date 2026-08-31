import { describe, it, expect, vi } from 'vitest';
import axios from 'axios';
import { readFileSync } from 'fs';
import { resolveApiVersion, RealAdoBackend } from '../src/backends/realAdo';
import type { AdoCredential } from '../src/auth/patAuth';
import type { AdoMcpConfig } from '../src/config/env';

vi.mock('fs', () => ({ readFileSync: vi.fn() }));

const credential: AdoCredential = { orgUrl: 'https://tfs.internal/tfs/Collection', pat: 'fake-pat' };

const testConfig: AdoMcpConfig = {
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

    const result = await resolveApiVersion(credential.orgUrl, testConfig.adoProject, ['7.1', '5.1', 'none'], credential, httpClient);

    expect(result).toBe('7.1');
    expect(getSpy).toHaveBeenCalledTimes(1);
    expect(getSpy.mock.calls[0][0]).toContain('api-version=7.1');
  });

  it('falls back to the second ladder entry when the first returns 400 (version mismatch)', async () => {
    const httpClient = axios.create();
    const getSpy = vi
      .spyOn(httpClient, 'get')
      .mockRejectedValueOnce({ response: { status: 400 } })
      .mockResolvedValueOnce({ status: 200, data: {} });

    const result = await resolveApiVersion(credential.orgUrl, testConfig.adoProject, ['7.1', '5.1', 'none'], credential, httpClient);

    expect(result).toBe('5.1');
    expect(getSpy).toHaveBeenCalledTimes(2);
  });

  it('falls back to "none" (omits the query param) when both versions 400', async () => {
    const httpClient = axios.create();
    const getSpy = vi
      .spyOn(httpClient, 'get')
      .mockRejectedValueOnce({ response: { status: 400 } })
      .mockRejectedValueOnce({ response: { status: 400 } })
      .mockResolvedValueOnce({ status: 200, data: {} });

    const result = await resolveApiVersion(credential.orgUrl, testConfig.adoProject, ['7.1', '5.1', 'none'], credential, httpClient);

    expect(result).toBe('none');
    expect(getSpy.mock.calls[2][0]).not.toContain('api-version');
  });

  it('throws if every ladder entry returns 400', async () => {
    const httpClient = axios.create();
    vi.spyOn(httpClient, 'get').mockRejectedValue({ response: { status: 400 } });

    await expect(resolveApiVersion(credential.orgUrl, testConfig.adoProject, ['7.1', '5.1', 'none'], credential, httpClient)).rejects.toThrow(
      /no api-version/i,
    );
  });

  it('fails immediately on a non-400 status (e.g. 401 bad PAT) without exhausting the ladder', async () => {
    const httpClient = axios.create();
    const getSpy = vi.spyOn(httpClient, 'get').mockRejectedValue({ response: { status: 401 } });

    await expect(resolveApiVersion(credential.orgUrl, testConfig.adoProject, ['7.1', '5.1', 'none'], credential, httpClient)).rejects.toThrow(
      /401/,
    );
    expect(getSpy).toHaveBeenCalledTimes(1);
  });

  it('probes the project-scoped wit/fields endpoint, not org-level connectionData', async () => {
    // Regression: found live against a real ADO org that connectionData
    // rejects api-version 7.1/7.0/5.1 with 400 (resolving to "none"), while
    // the actual wit/workitems create endpoint accepts 7.1 directly and,
    // unlike connectionData, hard-requires an explicit api-version --
    // "none" 400'd there with "No api-version was supplied". Probing the
    // same _apis/wit/* family we actually write to avoids that mismatch.
    const httpClient = axios.create();
    const getSpy = vi.spyOn(httpClient, 'get').mockResolvedValueOnce({ status: 200, data: {} });

    await resolveApiVersion(credential.orgUrl, testConfig.adoProject, ['7.1'], credential, httpClient);

    const url = getSpy.mock.calls[0][0] as string;
    expect(url).toContain(`/${testConfig.adoProject}/_apis/wit/fields`);
    expect(url).not.toContain('connectionData');
  });

  it('sends the PAT as a Basic auth header on every probe', async () => {
    const httpClient = axios.create();
    const getSpy = vi.spyOn(httpClient, 'get').mockResolvedValueOnce({ status: 200, data: {} });

    await resolveApiVersion(credential.orgUrl, testConfig.adoProject, ['7.1'], credential, httpClient);

    const expectedHeader = `Basic ${Buffer.from(':fake-pat').toString('base64')}`;
    expect(getSpy.mock.calls[0][1]?.headers?.Authorization).toBe(expectedHeader);
  });

  it('retries the same ladder candidate on a 503 before resolving it (does not fall through to the next rung)', async () => {
    const httpClient = axios.create();
    const getSpy = vi
      .spyOn(httpClient, 'get')
      .mockRejectedValueOnce({ response: { status: 503 } })
      .mockResolvedValueOnce({ status: 200, data: {} });

    const result = await resolveApiVersion(credential.orgUrl, testConfig.adoProject, ['7.1', '5.1', 'none'], credential, httpClient);

    expect(result).toBe('7.1');
    expect(getSpy).toHaveBeenCalledTimes(2);
    expect(getSpy.mock.calls[0][0]).toContain('api-version=7.1');
    expect(getSpy.mock.calls[1][0]).toContain('api-version=7.1');
  });

  it("RealAdoBackend's api-version probe itself targets the per-request project, not config.adoProject", async () => {
    // Discriminating regression test for a real gap found while wiring the
    // per-project fix: every RealAdoBackend method computed its own `proj`
    // (project ?? config.adoProject) for its real endpoint URL, but called
    // `getApiVersion()` with NO argument -- so the api-version LADDER PROBE
    // itself always ran against config.adoProject's URL regardless of which
    // project the call was actually scoped to. Asserts on the FIRST get
    // call (the probe) specifically, not the second (the real endpoint) --
    // every pre-existing "overrides config.adoProject" test in this file
    // only checked the second call and would not have caught this.
    const backend = new RealAdoBackend(testConfig, credential);
    const httpClient = axios.create();
    const getSpy = vi
      .spyOn(httpClient, 'get')
      .mockResolvedValueOnce({ status: 200, data: {} }) // api-version probe
      .mockResolvedValueOnce({ status: 200, data: { name: 'OtherProject', children: [] } });
    // @ts-expect-error -- injecting the spied client
    backend.httpClient = httpClient;

    await backend.readAreaPaths(5, 'OtherProject');

    const probeUrl = getSpy.mock.calls[0][0] as string;
    expect(probeUrl).toContain('/OtherProject/_apis/wit/fields');
    expect(probeUrl).not.toContain('/MyProject/');
  });
});

describe('RealAdoBackend.resolveProject (fail-loud on a missing project)', () => {
  it('throws a clear error rather than silently building a URL with "undefined" when neither a per-request project nor config.adoProject is set', async () => {
    const noDefaultConfig: AdoMcpConfig = { ...testConfig, adoProject: undefined };
    const backend = new RealAdoBackend(noDefaultConfig, credential);
    const httpClient = axios.create();
    const getSpy = vi.spyOn(httpClient, 'get');
    const postSpy = vi.spyOn(httpClient, 'post');
    // @ts-expect-error -- injecting the spied client
    backend.httpClient = httpClient;

    await expect(backend.createWorkItem({ type: 'Requirement', fields: {} })).rejects.toThrow(
      /No ADO project resolved/,
    );
    // Confirms this fails BEFORE any real HTTP call, not on a malformed response.
    expect(getSpy).not.toHaveBeenCalled();
    expect(postSpy).not.toHaveBeenCalled();
  });

  it('still falls back to config.adoProject when no per-request project is given and a default IS configured', async () => {
    const backend = new RealAdoBackend(testConfig, credential);
    const httpClient = axios.create();
    vi.spyOn(httpClient, 'get').mockResolvedValueOnce({ status: 200, data: {} });
    const postSpy = vi.spyOn(httpClient, 'post').mockResolvedValueOnce({ status: 200, data: { id: 1, fields: {} } });
    // @ts-expect-error -- injecting the spied client
    backend.httpClient = httpClient;

    await backend.createWorkItem({ type: 'Requirement', fields: {} });

    expect(postSpy.mock.calls[0][0]).toContain(`/${testConfig.adoProject}/_apis/wit/workitems/$Requirement`);
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

  it('targets the per-request project, not config.adoProject, when one is passed', async () => {
    // Discriminating test: config.adoProject ('MyProject') and the passed
    // project ('OtherProject') are deliberately DIFFERENT values here -- a
    // test asserting against config.adoProject with no override supplied
    // would pass even if this parameter were silently ignored. This is the
    // real bug the project param exists to fix: a job whose area path
    // belongs to a different project than the server's configured default
    // must have its work item created into ITS OWN project, not the
    // server-wide default.
    const backend = new RealAdoBackend(testConfig, credential);
    const httpClient = axios.create();
    vi.spyOn(httpClient, 'get').mockResolvedValueOnce({ status: 200, data: {} }); // api-version probe
    const postSpy = vi.spyOn(httpClient, 'post').mockResolvedValueOnce({ status: 200, data: { id: 7, fields: {} } });
    // @ts-expect-error -- injecting the spied client
    backend.httpClient = httpClient;

    await backend.createWorkItem({ type: 'Requirement', fields: {} }, 'OtherProject');

    expect(postSpy.mock.calls[0][0]).toContain('/OtherProject/_apis/wit/workitems/$Requirement');
    expect(postSpy.mock.calls[0][0]).not.toContain('/MyProject/');
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

describe('RealAdoBackend.getWorkItemsBatch', () => {
  it('returns an empty array without making any HTTP call for an empty id list', async () => {
    const backend = new RealAdoBackend(testConfig, credential);
    const httpClient = axios.create();
    const getSpy = vi.spyOn(httpClient, 'get');
    // @ts-expect-error -- injecting the spied client
    backend.httpClient = httpClient;

    expect(await backend.getWorkItemsBatch([])).toEqual([]);
    expect(getSpy).not.toHaveBeenCalled();
  });

  it('chunks ids at config.batchSize and issues one comma-joined GET per chunk', async () => {
    const smallBatchConfig: AdoMcpConfig = { ...testConfig, batchSize: 2, concurrency: 8 };
    const backend = new RealAdoBackend(smallBatchConfig, credential);
    const httpClient = axios.create();
    const getSpy = vi
      .spyOn(httpClient, 'get')
      .mockResolvedValueOnce({ status: 200, data: {} }) // api-version probe
      .mockResolvedValueOnce({
        status: 200,
        data: { value: [{ id: 1, fields: { 'System.WorkItemType': 'Requirement' } }, { id: 2, fields: { 'System.WorkItemType': 'Requirement' } }] },
      })
      .mockResolvedValueOnce({
        status: 200,
        data: { value: [{ id: 3, fields: { 'System.WorkItemType': 'Requirement' } }] },
      });
    // @ts-expect-error -- injecting the spied client
    backend.httpClient = httpClient;

    const results = await backend.getWorkItemsBatch([1, 2, 3]);

    expect(results.map((r) => r.id)).toEqual([1, 2, 3]);
    // 1 api-version probe + 2 chunk GETs (batchSize=2 over 3 ids -> [1,2], [3])
    expect(getSpy).toHaveBeenCalledTimes(3);
    expect(getSpy.mock.calls[1][0]).toContain('ids=1,2');
    expect(getSpy.mock.calls[2][0]).toContain('ids=3');
  });

  it('dispatches chunk requests with bounded concurrency, not all at once', async () => {
    // batchSize=1 -> 4 chunks of 1 id each; concurrency=2 -> at most 2
    // in-flight GETs (beyond the initial api-version probe) at any moment.
    const boundedConfig: AdoMcpConfig = { ...testConfig, batchSize: 1, concurrency: 2 };
    const backend = new RealAdoBackend(boundedConfig, credential);
    const httpClient = axios.create();
    let inFlight = 0;
    let maxInFlight = 0;
    const getSpy = vi.spyOn(httpClient, 'get').mockImplementation(async (url: string) => {
      if (url.includes('ids=')) {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        const id = Number(url.match(/ids=(\d+)/)?.[1]);
        return { status: 200, data: { value: [{ id, fields: { 'System.WorkItemType': 'Requirement' } }] } };
      }
      return { status: 200, data: {} }; // api-version probe
    });
    // @ts-expect-error -- injecting the spied client
    backend.httpClient = httpClient;

    const results = await backend.getWorkItemsBatch([1, 2, 3, 4]);

    expect(results.map((r) => r.id).sort()).toEqual([1, 2, 3, 4]);
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(getSpy).toHaveBeenCalledTimes(5); // 1 probe + 4 single-id chunk GETs
  });

  it('requests errorPolicy=Omit -- ADO\'s default for this endpoint FAILS the whole request if any id is missing, not omits it', async () => {
    // Real gap this closes: a deleted/nonexistent id anywhere in the batch
    // would otherwise 400 (TF401232) the ENTIRE chunk with no ADO default
    // omission -- the exact detection signal stale-match verification
    // (DryRunService.verifyExistingAdoIdsStillExist) depends on.
    const backend = new RealAdoBackend(testConfig, credential);
    const httpClient = axios.create();
    const getSpy = vi
      .spyOn(httpClient, 'get')
      .mockResolvedValueOnce({ status: 200, data: {} }) // api-version probe
      .mockResolvedValueOnce({
        status: 200,
        data: { value: [{ id: 1, fields: { 'System.WorkItemType': 'Requirement' } }] },
      });
    // @ts-expect-error -- injecting the spied client
    backend.httpClient = httpClient;

    await backend.getWorkItemsBatch([1, 999999]);

    expect(getSpy.mock.calls[1][0]).toContain('errorPolicy=Omit');
  });

  it('a real deleted id is simply absent from the result, not an error, when errorPolicy=Omit is honored', async () => {
    const backend = new RealAdoBackend(testConfig, credential);
    const httpClient = axios.create();
    vi.spyOn(httpClient, 'get')
      .mockResolvedValueOnce({ status: 200, data: {} }) // api-version probe
      .mockResolvedValueOnce({
        // ADO's real response when errorPolicy=Omit and one id (999999) doesn't exist.
        status: 200,
        data: { value: [{ id: 1, fields: { 'System.WorkItemType': 'Requirement' } }] },
      });
    // @ts-expect-error -- injecting the spied client
    backend.httpClient = httpClient;

    const results = await backend.getWorkItemsBatch([1, 999999]);

    expect(results.map((r) => r.id)).toEqual([1]);
  });

  it('tolerates a null placeholder for a dead id instead of true omission -- confirmed live crash', async () => {
    // Real gap this closes: errorPolicy=Omit does not always drop a
    // dead/deleted id from the response array -- ADO can instead return a
    // `null` entry in its place. Confirmed live: this crashed the whole
    // batch with "Cannot read properties of null (reading 'id')",
    // silently defeating DryRunService.verifyExistingAdoIdsStillExist's
    // stale-match check for every id in the batch, not just the dead one
    // -- a deleted-in-ADO dedup match then stayed in a job's diff
    // unverified and un-downgraded.
    const backend = new RealAdoBackend(testConfig, credential);
    const httpClient = axios.create();
    vi.spyOn(httpClient, 'get')
      .mockResolvedValueOnce({ status: 200, data: {} }) // api-version probe
      .mockResolvedValueOnce({
        status: 200,
        data: { value: [{ id: 1, fields: { 'System.WorkItemType': 'Requirement' } }, null] },
      });
    // @ts-expect-error -- injecting the spied client
    backend.httpClient = httpClient;

    const results = await backend.getWorkItemsBatch([1, 532]);

    expect(results.map((r) => r.id)).toEqual([1]);
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

  it('combines multiple field-match entries with AND, using UNDER for System.AreaPath and = for every other field', async () => {
    // Regression: System.AreaPath previously used exact-match (=), which
    // misses nested area-path sub-nodes -- a normal ADO hierarchy shape.
    // UNDER matches the node itself plus its entire subtree. Every other
    // field keeps exact-match semantics, unaffected by this fix.
    const backend = new RealAdoBackend(testConfig, credential);
    const httpClient = axios.create();
    vi.spyOn(httpClient, 'get').mockResolvedValueOnce({ status: 200, data: {} });
    const postSpy = vi.spyOn(httpClient, 'post').mockResolvedValueOnce({ status: 200, data: { workItems: [] } });
    // @ts-expect-error -- injecting the spied client
    backend.httpClient = httpClient;

    await backend.queryIds({ 'Custom.SourceHash': 'abc123', 'System.AreaPath': 'Project\\Area1' });

    const query = postSpy.mock.calls[0][1].query;
    expect(query).toContain("[Custom.SourceHash] = 'abc123'");
    expect(query).toContain("[System.AreaPath] UNDER 'Project\\Area1'");
    expect(query).not.toContain("[System.AreaPath] = ");
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

  it('uses config.adoProject by default', async () => {
    const backend = new RealAdoBackend(testConfig, credential);
    const httpClient = axios.create();
    vi.spyOn(httpClient, 'get').mockResolvedValueOnce({ status: 200, data: {} });
    const postSpy = vi.spyOn(httpClient, 'post').mockResolvedValueOnce({ status: 200, data: { workItems: [] } });
    // @ts-expect-error -- injecting the spied client
    backend.httpClient = httpClient;

    await backend.queryIds({ 'System.AreaPath': 'Project\\Area1' });

    expect(postSpy.mock.calls[0][0]).toContain(`/${testConfig.adoProject}/_apis/wit/wiql`);
  });

  it('uses the given project instead of the configured default', async () => {
    const backend = new RealAdoBackend(testConfig, credential);
    const httpClient = axios.create();
    vi.spyOn(httpClient, 'get').mockResolvedValueOnce({ status: 200, data: {} });
    const postSpy = vi.spyOn(httpClient, 'post').mockResolvedValueOnce({ status: 200, data: { workItems: [] } });
    // @ts-expect-error -- injecting the spied client
    backend.httpClient = httpClient;

    await backend.queryIds({ 'System.AreaPath': 'OtherProject\\Area1' }, 'OtherProject');

    expect(postSpy.mock.calls[0][0]).toContain('/OtherProject/_apis/wit/wiql');
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
        // Real ADO wraps list responses as { count, value: [...] }, not { fields: [...] } --
        // this fixture previously used the wrong shape and masked a real bug (see realAdo.ts).
        data: {
          count: 3,
          value: [
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

  it('targets the per-request project, not config.adoProject, when one is passed', async () => {
    // Discriminating: config.adoProject and the passed project deliberately
    // differ -- see createWorkItem's own identical-shaped test for why.
    const backend = new RealAdoBackend(testConfig, credential);
    const httpClient = axios.create();
    const getSpy = vi
      .spyOn(httpClient, 'get')
      .mockResolvedValueOnce({ status: 200, data: {} })
      .mockResolvedValueOnce({ status: 200, data: { count: 0, value: [] } });
    // @ts-expect-error -- injecting the spied client
    backend.httpClient = httpClient;

    await backend.discoverFields('Requirement', 'OtherProject');

    expect(getSpy.mock.calls[1][0]).toContain('/OtherProject/_apis/wit/workitemtypes/Requirement/fields');
    expect(getSpy.mock.calls[1][0]).not.toContain('/MyProject/');
  });
});

describe('RealAdoBackend.discoverFieldsDetailed', () => {
  it('requests the allowedValues expand and parses each field\'s picklist metadata', async () => {
    const backend = new RealAdoBackend(testConfig, credential);
    const httpClient = axios.create();
    const getSpy = vi
      .spyOn(httpClient, 'get')
      .mockResolvedValueOnce({ status: 200, data: {} }) // api-version probe
      .mockResolvedValueOnce({
        status: 200,
        data: {
          count: 2,
          value: [
            { referenceName: 'System.Title' },
            {
              referenceName: 'Microsoft.VSTS.CMMI.RequirementType',
              allowedValues: ['Functional', 'Safety', 'Security'],
              alwaysRequired: true,
            },
          ],
        },
      });
    // @ts-expect-error -- injecting the spied client
    backend.httpClient = httpClient;

    const result = await backend.discoverFieldsDetailed('Requirement');

    expect(getSpy.mock.calls[1][0]).toContain('$expand=allowedValues');
    // A field the response entry omits allowedValues/alwaysRequired for
    // (a non-picklist field) must parse to [] / false, never undefined --
    // an absent list and an empty list are the same fact for every caller.
    expect(result).toEqual([
      { referenceName: 'System.Title', allowedValues: [], alwaysRequired: false },
      {
        referenceName: 'Microsoft.VSTS.CMMI.RequirementType',
        allowedValues: ['Functional', 'Safety', 'Security'],
        alwaysRequired: true,
      },
    ]);
  });

  it('builds a "?"-prefixed $expand when the resolved api-version is "none" -- no stray "&"', async () => {
    const noneVersionConfig: AdoMcpConfig = { ...testConfig, apiVersionLadder: ['none'] };
    const backend = new RealAdoBackend(noneVersionConfig, credential);
    const httpClient = axios.create();
    const getSpy = vi
      .spyOn(httpClient, 'get')
      .mockResolvedValueOnce({ status: 200, data: {} }) // api-version probe
      .mockResolvedValueOnce({ status: 200, data: { count: 0, value: [] } });
    // @ts-expect-error -- injecting the spied client
    backend.httpClient = httpClient;

    await backend.discoverFieldsDetailed('Requirement');

    const url = getSpy.mock.calls[1][0] as string;
    expect(url).toContain('/fields?$expand=allowedValues');
    expect(url).not.toContain('&&');
    expect(url).not.toMatch(/\?.*&\$expand/);
  });

  it('targets the per-request project, not config.adoProject, when one is passed', async () => {
    // Discriminating: config.adoProject and the passed project deliberately
    // differ -- see createWorkItem's own identical-shaped test for why.
    const backend = new RealAdoBackend(testConfig, credential);
    const httpClient = axios.create();
    const getSpy = vi
      .spyOn(httpClient, 'get')
      .mockResolvedValueOnce({ status: 200, data: {} })
      .mockResolvedValueOnce({ status: 200, data: { count: 0, value: [] } });
    // @ts-expect-error -- injecting the spied client
    backend.httpClient = httpClient;

    await backend.discoverFieldsDetailed('Requirement', 'OtherProject');

    expect(getSpy.mock.calls[1][0]).toContain('/OtherProject/_apis/wit/workitemtypes/Requirement/fields');
    expect(getSpy.mock.calls[1][0]).not.toContain('/MyProject/');
  });
});

describe('RealAdoBackend.readAreaPaths', () => {
  it('uses config.adoProject by default', async () => {
    const backend = new RealAdoBackend(testConfig, credential);
    const httpClient = axios.create();
    const getSpy = vi
      .spyOn(httpClient, 'get')
      .mockResolvedValueOnce({ status: 200, data: {} }) // api-version probe
      .mockResolvedValueOnce({ status: 200, data: { name: 'MyProject', children: [] } });
    // @ts-expect-error -- injecting the spied client
    backend.httpClient = httpClient;

    const result = await backend.readAreaPaths(5);

    expect(getSpy.mock.calls[1][0]).toContain('/MyProject/_apis/wit/classificationnodes/areas');
    expect(result.path).toBe('MyProject');
  });

  it('overrides config.adoProject when a project argument is passed', async () => {
    const backend = new RealAdoBackend(testConfig, credential);
    const httpClient = axios.create();
    const getSpy = vi
      .spyOn(httpClient, 'get')
      .mockResolvedValueOnce({ status: 200, data: {} }) // api-version probe
      .mockResolvedValueOnce({ status: 200, data: { name: 'OtherProject', children: [] } });
    // @ts-expect-error -- injecting the spied client
    backend.httpClient = httpClient;

    const result = await backend.readAreaPaths(5, 'OtherProject');

    expect(getSpy.mock.calls[1][0]).toContain('/OtherProject/_apis/wit/classificationnodes/areas');
    expect(result.path).toBe('OtherProject');
  });
});

describe('RealAdoBackend.readStates', () => {
  it('uses config.adoProject by default', async () => {
    const backend = new RealAdoBackend(testConfig, credential);
    const httpClient = axios.create();
    const getSpy = vi
      .spyOn(httpClient, 'get')
      .mockResolvedValueOnce({ status: 200, data: {} }) // api-version probe
      .mockResolvedValueOnce({ status: 200, data: { value: [{ name: 'Proposed' }, { name: 'Active' }] } });
    // @ts-expect-error -- injecting the spied client
    backend.httpClient = httpClient;

    const result = await backend.readStates('Requirement');

    expect(getSpy.mock.calls[1][0]).toContain('/MyProject/_apis/wit/workitemtypes/Requirement/states');
    expect(result).toEqual(['Proposed', 'Active']);
  });

  it('overrides config.adoProject when a project argument is passed -- process templates (and their states) can genuinely differ per project', async () => {
    const backend = new RealAdoBackend(testConfig, credential);
    const httpClient = axios.create();
    const getSpy = vi
      .spyOn(httpClient, 'get')
      .mockResolvedValueOnce({ status: 200, data: {} }) // api-version probe
      .mockResolvedValueOnce({ status: 200, data: { value: [{ name: 'New' }, { name: 'Committed' }, { name: 'Done' }] } });
    // @ts-expect-error -- injecting the spied client
    backend.httpClient = httpClient;

    const result = await backend.readStates('Requirement', 'OtherProject');

    expect(getSpy.mock.calls[1][0]).toContain('/OtherProject/_apis/wit/workitemtypes/Requirement/states');
    expect(result).toEqual(['New', 'Committed', 'Done']);
  });
});

describe('RealAdoBackend.discoverWorkItemTypeCategories', () => {
  it('resolves Epic/Feature/Requirement categories to their real defaultWorkItemType names', async () => {
    // Confirmed real bug this fixes: createWorkItem previously sent
    // req2ado's internal "Requirement" label straight to ADO as the type
    // name -- correct only for CMMI. An Agile project's real
    // Requirement-category type is "User Story" -- this is the case that
    // matters most.
    const backend = new RealAdoBackend(testConfig, credential);
    const httpClient = axios.create();
    const getSpy = vi
      .spyOn(httpClient, 'get')
      .mockResolvedValueOnce({ status: 200, data: {} }) // api-version probe
      .mockResolvedValueOnce({
        status: 200,
        data: {
          value: [
            { referenceName: 'Microsoft.EpicCategory', defaultWorkItemType: { name: 'Epic' } },
            { referenceName: 'Microsoft.FeatureCategory', defaultWorkItemType: { name: 'Feature' } },
            { referenceName: 'Microsoft.RequirementCategory', defaultWorkItemType: { name: 'User Story' } },
            { referenceName: 'Microsoft.TaskCategory', defaultWorkItemType: { name: 'Task' } },
          ],
        },
      });
    // @ts-expect-error -- injecting the spied client
    backend.httpClient = httpClient;

    const result = await backend.discoverWorkItemTypeCategories();

    expect(getSpy.mock.calls[1][0]).toContain('/MyProject/_apis/wit/workitemtypecategories');
    expect(result).toEqual({ Epic: 'Epic', Feature: 'Feature', Requirement: 'User Story' });
  });

  it('overrides config.adoProject when a project argument is passed', async () => {
    const backend = new RealAdoBackend(testConfig, credential);
    const httpClient = axios.create();
    vi.spyOn(httpClient, 'get')
      .mockResolvedValueOnce({ status: 200, data: {} })
      .mockResolvedValueOnce({
        status: 200,
        data: {
          value: [
            { referenceName: 'Microsoft.EpicCategory', defaultWorkItemType: { name: 'Epic' } },
            { referenceName: 'Microsoft.FeatureCategory', defaultWorkItemType: { name: 'Feature' } },
            { referenceName: 'Microsoft.RequirementCategory', defaultWorkItemType: { name: 'Product Backlog Item' } },
          ],
        },
      });
    // @ts-expect-error -- injecting the spied client
    backend.httpClient = httpClient;

    const result = await backend.discoverWorkItemTypeCategories('OtherProject');

    expect(result.Requirement).toBe('Product Backlog Item');
  });

  it('throws a clear error when a category is missing from the process template response', async () => {
    const backend = new RealAdoBackend(testConfig, credential);
    const httpClient = axios.create();
    vi.spyOn(httpClient, 'get')
      .mockResolvedValueOnce({ status: 200, data: {} })
      .mockResolvedValueOnce({
        status: 200,
        data: {
          value: [
            { referenceName: 'Microsoft.EpicCategory', defaultWorkItemType: { name: 'Epic' } },
            { referenceName: 'Microsoft.FeatureCategory', defaultWorkItemType: { name: 'Feature' } },
            // Requirement category missing entirely
          ],
        },
      });
    // @ts-expect-error -- injecting the spied client
    backend.httpClient = httpClient;

    await expect(backend.discoverWorkItemTypeCategories()).rejects.toThrow(/missing an expected work-item-type category/);
  });
});

describe('RealAdoBackend.discoverProjects', () => {
  it('GETs the collection-level projects endpoint and maps id/name', async () => {
    const backend = new RealAdoBackend(testConfig, credential);
    const httpClient = axios.create();
    const getSpy = vi
      .spyOn(httpClient, 'get')
      .mockResolvedValueOnce({ status: 200, data: {} }) // api-version probe
      .mockResolvedValueOnce({
        status: 200,
        data: { count: 2, value: [{ id: 'abc-1', name: 'Project' }, { id: 'abc-2', name: 'OtherProject' }] },
      });
    // @ts-expect-error -- injecting the spied client
    backend.httpClient = httpClient;

    const result = await backend.discoverProjects();

    expect(getSpy.mock.calls[1][0]).toContain('/_apis/projects');
    expect(getSpy.mock.calls[1][0]).not.toContain('/MyProject/_apis/projects');
    expect(result).toEqual([
      { id: 'abc-1', name: 'Project' },
      { id: 'abc-2', name: 'OtherProject' },
    ]);
  });
});

describe('RealAdoBackend.getWorkItemIcon', () => {
  it('embeds api-version inside the Accept header, matching the real SDK -- a bare image/svg+xml still negotiates to JSON', async () => {
    const backend = new RealAdoBackend(testConfig, credential);
    const httpClient = axios.create();
    vi.spyOn(httpClient, 'get')
      .mockResolvedValueOnce({ status: 200, data: {} }) // api-version probe
      .mockResolvedValueOnce({
        status: 200,
        headers: { 'content-type': 'image/svg+xml' },
        data: Buffer.from('<svg></svg>'),
      });
    // @ts-expect-error -- injecting the spied client for the test
    backend.httpClient = httpClient;

    const result = await backend.getWorkItemIcon('icon_clipboard', 'AD3737');

    const iconCall = httpClient.get.mock.calls[1];
    expect(iconCall[0]).toContain('/_apis/wit/workitemicons/icon_clipboard');
    // testConfig.apiVersionLadder is ['7.1'] -- confirmed against
    // azure-devops-node-api's own ClientApiBase.createAcceptHeader
    // (`type + ';api-version=' + apiVersion`), the exact mechanism the
    // official SDK uses for this endpoint's getWorkItemIconSvg.
    expect(iconCall[1]?.headers?.Accept).toBe('image/svg+xml;api-version=7.1');
    expect(result.contentType).toBe('image/svg+xml');
  });

  it('falls back to a bare image/svg+xml Accept header when the api-version ladder resolves to none', async () => {
    const backend = new RealAdoBackend({ ...testConfig, apiVersionLadder: ['none'] }, credential);
    const httpClient = axios.create();
    vi.spyOn(httpClient, 'get')
      .mockResolvedValueOnce({ status: 200, data: {} }) // api-version probe
      .mockResolvedValueOnce({
        status: 200,
        headers: { 'content-type': 'image/svg+xml' },
        data: Buffer.from('<svg></svg>'),
      });
    // @ts-expect-error -- injecting the spied client for the test
    backend.httpClient = httpClient;

    await backend.getWorkItemIcon('icon_clipboard', 'AD3737');

    const iconCall = httpClient.get.mock.calls[1];
    expect(iconCall[1]?.headers?.Accept).toBe('image/svg+xml');
    expect(iconCall[0]).not.toContain('api-version');
  });
});

describe('RealAdoBackend.uploadAttachment', () => {
  it('POSTs raw bytes to attachments, then PATCHes an AttachedFile relation onto the work item', async () => {
    const backend = new RealAdoBackend(testConfig, credential);
    const httpClient = axios.create();
    vi.spyOn(httpClient, 'get').mockResolvedValueOnce({ status: 200, data: {} }); // api-version probe
    const postSpy = vi
      .spyOn(httpClient, 'post')
      .mockResolvedValueOnce({ status: 200, data: { id: 'attachment-guid', url: 'https://tfs.internal/tfs/Collection/_apis/wit/attachments/attachment-guid' } });
    const patchSpy = vi.spyOn(httpClient, 'patch').mockResolvedValueOnce({ status: 200, data: {} });
    // @ts-expect-error -- injecting the spied client
    backend.httpClient = httpClient;

    await backend.uploadAttachment(42, 'figure-f0.png', Buffer.from('fake-png-bytes').toString('base64'), 'image/png');

    expect(postSpy.mock.calls[0][0]).toContain('/_apis/wit/attachments?fileName=figure-f0.png');
    expect(postSpy.mock.calls[0][1]).toEqual(Buffer.from('fake-png-bytes'));
    // ADO's attachments-create endpoint only accepts application/octet-stream
    // (confirmed via the official REST reference and a live 400 -- the
    // figure's real mimeType must never reach this header).
    expect(postSpy.mock.calls[0][2]?.headers?.['Content-Type']).toBe('application/octet-stream');

    expect(patchSpy.mock.calls[0][0]).toContain('/wit/workitems/42');
    expect(patchSpy.mock.calls[0][1]).toEqual([
      {
        op: 'add',
        path: '/relations/-',
        value: {
          rel: 'AttachedFile',
          url: 'https://tfs.internal/tfs/Collection/_apis/wit/attachments/attachment-guid',
          attributes: { comment: 'figure-f0.png' },
        },
      },
    ]);
  });

  it('url-encodes a fileName containing special characters', async () => {
    const backend = new RealAdoBackend(testConfig, credential);
    const httpClient = axios.create();
    vi.spyOn(httpClient, 'get').mockResolvedValueOnce({ status: 200, data: {} });
    const postSpy = vi.spyOn(httpClient, 'post').mockResolvedValueOnce({ status: 200, data: { url: 'https://tfs.internal/attachments/x' } });
    vi.spyOn(httpClient, 'patch').mockResolvedValueOnce({ status: 200, data: {} });
    // @ts-expect-error -- injecting the spied client
    backend.httpClient = httpClient;

    await backend.uploadAttachment(1, 'figure f0 (rev 2).png', Buffer.from('x').toString('base64'), 'image/png');

    expect(postSpy.mock.calls[0][0]).toContain(`fileName=${encodeURIComponent('figure f0 (rev 2).png')}`);
  });

  it('targets the per-request project, not config.adoProject, when one is passed', async () => {
    // Discriminating: config.adoProject and the passed project deliberately
    // differ -- see createWorkItem's own identical-shaped test for why.
    const backend = new RealAdoBackend(testConfig, credential);
    const httpClient = axios.create();
    vi.spyOn(httpClient, 'get').mockResolvedValueOnce({ status: 200, data: {} });
    const postSpy = vi
      .spyOn(httpClient, 'post')
      .mockResolvedValueOnce({ status: 200, data: { id: 'attachment-guid', url: 'https://tfs.internal/tfs/Collection/_apis/wit/attachments/attachment-guid' } });
    vi.spyOn(httpClient, 'patch').mockResolvedValueOnce({ status: 200, data: {} });
    // @ts-expect-error -- injecting the spied client
    backend.httpClient = httpClient;

    await backend.uploadAttachment(1, 'fig.png', Buffer.from('x').toString('base64'), 'image/png', 'OtherProject');

    expect(postSpy.mock.calls[0][0]).toContain('/OtherProject/_apis/wit/attachments');
    expect(postSpy.mock.calls[0][0]).not.toContain('/MyProject/');
  });

  it('retries the upload on a 429 before succeeding', async () => {
    const backend = new RealAdoBackend(testConfig, credential);
    const httpClient = axios.create();
    vi.spyOn(httpClient, 'get').mockResolvedValueOnce({ status: 200, data: {} });
    const postSpy = vi
      .spyOn(httpClient, 'post')
      .mockRejectedValueOnce({ response: { status: 429 } })
      .mockResolvedValueOnce({ status: 200, data: { url: 'https://tfs.internal/attachments/x' } });
    vi.spyOn(httpClient, 'patch').mockResolvedValueOnce({ status: 200, data: {} });
    // @ts-expect-error -- injecting the spied client
    backend.httpClient = httpClient;

    await backend.uploadAttachment(1, 'fig.png', Buffer.from('x').toString('base64'), 'image/png');
    expect(postSpy).toHaveBeenCalledTimes(2);
  });
});

describe('RealAdoBackend.discoverLinkTypes', () => {
  it('accepts an optional project param for interface parity but does not scope the URL to it -- workitemrelationtypes is collection-level', async () => {
    // Unlike createWorkItem/discoverFields/discoverFieldsDetailed/
    // uploadAttachment, there is no wrong-project bug to fix here: real
    // ADO's workitemrelationtypes endpoint has no {project}/ segment at
    // all, so a project override genuinely has nowhere to apply. This test
    // documents that deliberately, rather than leaving it unverified.
    const backend = new RealAdoBackend(testConfig, credential);
    const httpClient = axios.create();
    const getSpy = vi
      .spyOn(httpClient, 'get')
      .mockResolvedValueOnce({ status: 200, data: {} }) // api-version probe
      .mockResolvedValueOnce({
        status: 200,
        data: { value: [{ referenceName: 'System.LinkTypes.Hierarchy-Reverse', name: 'Parent' }] },
      });
    // @ts-expect-error -- injecting the spied client
    backend.httpClient = httpClient;

    await backend.discoverLinkTypes('OtherProject');

    const url = getSpy.mock.calls[1][0] as string;
    expect(url).toContain('/_apis/wit/workitemrelationtypes');
    expect(url).not.toContain('OtherProject');
    expect(url).not.toContain('MyProject');
  });

  it('falls back to the seed catalog when the live call fails', async () => {
    const backend = new RealAdoBackend(testConfig, credential);
    const httpClient = axios.create();
    vi.spyOn(httpClient, 'get')
      .mockResolvedValueOnce({ status: 200, data: {} })
      .mockRejectedValueOnce(new Error('network error'));
    // @ts-expect-error -- injecting the spied client
    backend.httpClient = httpClient;

    const result = await backend.discoverLinkTypes();

    expect(result.length).toBeGreaterThan(0);
  });
});

describe('RealAdoBackend CA-trust TLS construction', () => {
  it('constructs an https.Agent with the CA bundle when caCertPath is configured', () => {
    vi.mocked(readFileSync).mockReturnValue(Buffer.from('fake-ca-cert-content'));

    const backend = new RealAdoBackend({ ...testConfig, caCertPath: '/fake/ca.pem' }, credential);

    expect(readFileSync).toHaveBeenCalledWith('/fake/ca.pem');
    // @ts-expect-error -- inspecting the private client's constructed agent
    expect(backend.httpClient.defaults.httpsAgent).toBeDefined();
  });

  it('uses the default axios instance (no custom agent) when caCertPath is unset', () => {
    vi.mocked(readFileSync).mockClear();

    const backend = new RealAdoBackend({ ...testConfig, caCertPath: undefined }, credential);

    expect(readFileSync).not.toHaveBeenCalled();
    // @ts-expect-error -- inspecting the private client's constructed agent
    expect(backend.httpClient.defaults.httpsAgent).toBeUndefined();
  });
});
