import type { AxiosInstance } from 'axios';
import axios from 'axios';
import { readFileSync } from 'fs';
import https from 'https';
import { buildBasicAuthHeader, type AdoCredential } from '../auth/patAuth.js';
import type {
  AdoBackend,
  AdoProject,
  AreaPathNode,
  CreateWorkItemInput,
  WorkItemIcon,
  WorkItemRecord,
  WorkItemTypeCategoryMap,
  WorkItemTypeDefinition,
} from './types.js';
import type { AdoMcpConfig } from '../config/env.js';
import { retryWithBackoff } from './retryWithBackoff.js';
import { SEED_LINK_TYPES, isWorkItemRelationType, type AdoLinkType } from '../domain/adoLinkTypes.js';

/**
 * Builds the axios client used for all real ADO calls. When `caCertPath` is
 * configured (on-prem ADO behind a self-signed cert), trusts ONLY that
 * specific CA bundle via a dedicated https.Agent — never
 * `rejectUnauthorized: false`, which disables TLS trust entirely and is an
 * explicit anti-pattern per docs/architecture.md. When unset (CA-issued
 * cert, or dev/mock use), the default axios instance's default trust store
 * is correct as-is.
 */
function buildHttpClient(config: AdoMcpConfig): AxiosInstance {
  if (!config.caCertPath) {
    return axios.create();
  }
  const ca = readFileSync(config.caCertPath);
  return axios.create({ httpsAgent: new https.Agent({ ca }) });
}

/**
 * Probes the api-version fallback ladder (docs/architecture.md: "7.1 -> 5.1
 * -> none") against `{project}/_apis/wit/fields` -- the SAME endpoint family
 * (`_apis/wit/*`) every real write call (createWorkItem, linkParentChild,
 * setFields) actually uses -- with each candidate in order, using the first
 * one that responds 200. "none" omits the api-version query param entirely
 * -- some legacy on-prem endpoints predate versioning.
 *
 * Previously probed the org-level `_apis/connectionData` endpoint instead.
 * Found live against a real ADO org: connectionData rejected 7.1/7.0/5.1
 * with 400 (resolving to "none"), but the actual wit/workitems create
 * endpoint accepts 7.1 directly and, unlike connectionData, HARD REQUIRES an
 * explicit api-version -- "none" 400'd there with "No api-version was
 * supplied". connectionData's version gating doesn't represent the wit
 * endpoints' at all on this org; probing the family we actually call avoids
 * that mismatch.
 *
 * Exported standalone (not a RealAdoBackend method) so it can be reused
 * and tested independently of a full backend instance.
 */
export async function resolveApiVersion(
  orgUrl: string,
  project: string,
  apiVersionLadder: string[],
  credential: AdoCredential,
  httpClient: AxiosInstance,
): Promise<string> {
  const authHeader = buildBasicAuthHeader(credential.pat);
  let lastFailure: { status: number; url: string } | null = null;
  for (const version of apiVersionLadder) {
    const base = `${orgUrl.replace(/\/$/, '')}/${project}/_apis/wit/fields`;
    const url = version === 'none' ? base : `${base}?api-version=${version}`;
    try {
      const response = await retryWithBackoff(() => httpClient.get(url, { headers: { Authorization: authHeader } }));
      if (response.status === 200) {
        return version;
      }
    } catch (error: any) {
      const status = error?.response?.status;
      lastFailure = { status, url };
      // Only a 400 (e.g. VssInvalidPreviewVersionException) means THIS
      // api-version is wrong for this server -- try the next one. Any other
      // status (401 expired/invalid PAT, network error, etc.) is not fixed
      // by trying a different api-version -- fail immediately with the real
      // error rather than exhausting the whole ladder pointlessly. Mirrors
      // orchestrator's AdoPatProvider.validateAndIdentify.
      if (status !== 400) {
        throw new Error(`ADO wit/fields api-version probe failed: ${status ?? error?.message} at ${url}`);
      }
      continue;
    }
  }
  throw new Error(
    `No api-version in the ladder [${apiVersionLadder.join(', ')}] succeeded against ${orgUrl}` +
      (lastFailure ? ` (last failure: ${lastFailure.status} at ${lastFailure.url})` : ''),
  );
}

function versionQueryParam(version: string): string {
  return version === 'none' ? '' : `?api-version=${version}`;
}

function toJsonPatch(fields: Record<string, string>): { op: string; path: string; value: string }[] {
  return Object.entries(fields).map(([key, value]) => ({ op: 'add', path: `/fields/${key}`, value }));
}

function parentIdFromRelations(relations: { rel: string; url: string }[] | undefined): number | null {
  const parentRelation = relations?.find((relation) => relation.rel === 'System.LinkTypes.Hierarchy-Reverse');
  if (!parentRelation) return null;
  const match = parentRelation.url.match(/\/workItems\/(\d+)$/);
  return match ? Number(match[1]) : null;
}

function escapeWiqlValue(value: string): string {
  return value.replace(/'/g, "''");
}

function buildWiqlQuery(fieldMatch: Record<string, string>): string {
  // System.AreaPath uses UNDER, not = -- callers querying "everything under
  // this area path" (e.g. backfill.service.ts) need the whole subtree, not
  // just an exact-match node; confirmed via Microsoft's WIQL docs that
  // UNDER is fully supported at api-version 7.0 on-prem (this server's own
  // ladder already resolves there for a real Server 2022.1 instance -- see
  // config/env.ts), with no on-prem-vs-cloud quirk for this operator. Every
  // other field keeps exact-match semantics -- unrelated to this bug.
  const conditions = Object.entries(fieldMatch)
    .map(([field, value]) => `[${field}] ${field === 'System.AreaPath' ? 'UNDER' : '='} '${escapeWiqlValue(value)}'`)
    .join(' AND ');
  return `SELECT [System.Id] FROM WorkItems WHERE ${conditions}`;
}

/**
 * On-prem ADO REST implementation of AdoBackend (Phase 0's interface,
 * unchanged). createWorkItem/getWorkItem are implemented here via the
 * JSON-Patch work-item API; linkParentChild/queryIds remain stubs for
 * Tasks 3-4.
 */
export class RealAdoBackend implements AdoBackend {
  private httpClient: AxiosInstance;
  private resolvedApiVersion: string | null = null;

  constructor(
    private readonly config: AdoMcpConfig,
    private readonly credential: AdoCredential,
  ) {
    this.httpClient = buildHttpClient(config);
  }

  private authHeader(): string {
    return buildBasicAuthHeader(this.credential.pat);
  }

  private async getApiVersion(): Promise<string> {
    if (this.resolvedApiVersion === null) {
      this.resolvedApiVersion = await resolveApiVersion(
        this.credential.orgUrl,
        this.config.adoProject,
        this.config.apiVersionLadder,
        this.credential,
        this.httpClient,
      );
    }
    return this.resolvedApiVersion;
  }

  async ping(): Promise<{ ok: true; backend: 'real' }> {
    await this.getApiVersion();
    return { ok: true, backend: 'real' };
  }

  async createWorkItem(input: CreateWorkItemInput): Promise<WorkItemRecord> {
    const version = await this.getApiVersion();
    const url = `${this.credential.orgUrl.replace(/\/$/, '')}/${this.config.adoProject}/_apis/wit/workitems/$${input.type}${versionQueryParam(version)}`;
    const response = await retryWithBackoff(() =>
      this.httpClient.post(url, toJsonPatch(input.fields), {
        headers: { Authorization: this.authHeader(), 'Content-Type': 'application/json-patch+json' },
      }),
    );
    return {
      id: response.data.id,
      type: input.type,
      fields: input.fields,
      parentId: null,
    };
  }

  async getWorkItem(id: number): Promise<WorkItemRecord | null> {
    const version = await this.getApiVersion();
    const url = `${this.credential.orgUrl.replace(/\/$/, '')}/_apis/wit/workitems/${id}?$expand=relations${version === 'none' ? '' : `&api-version=${version}`}`;
    try {
      const response = await retryWithBackoff(() =>
        this.httpClient.get(url, { headers: { Authorization: this.authHeader() } }),
      );
      const data = response.data;
      return {
        id: data.id,
        type: data.fields['System.WorkItemType'] as string,
        fields: data.fields,
        parentId: parentIdFromRelations(data.relations),
      };
    } catch (error: any) {
      if (error?.response?.status === 404) return null;
      throw error;
    }
  }

  /**
   * Chunks `ids` at `config.batchSize` (ADO's own cap on the workitems-by-id
   * endpoint is 200) and dispatches chunks with bounded concurrency
   * (`config.concurrency`) instead of one getWorkItem call per id -- both
   * config fields were previously declared but never referenced anywhere.
   * Unknown ids are absent from the result via `errorPolicy=Omit`
   * (getWorkItemsChunk) -- ADO's own default for this endpoint is to FAIL
   * the entire request (400 TF401232) if ANY id in the batch doesn't
   * exist, not to omit it; without this param, a batch containing even
   * one stale/deleted id would throw for the whole chunk. This is the
   * exact detection signal DryRunService's stale-match verification
   * (a deleted-in-ADO reuse/dedup_skip match) depends on.
   */
  async getWorkItemsBatch(ids: number[]): Promise<WorkItemRecord[]> {
    if (ids.length === 0) return [];
    const version = await this.getApiVersion();
    const chunks: number[][] = [];
    for (let i = 0; i < ids.length; i += this.config.batchSize) {
      chunks.push(ids.slice(i, i + this.config.batchSize));
    }

    const results: WorkItemRecord[][] = [];
    for (let i = 0; i < chunks.length; i += this.config.concurrency) {
      const window = chunks.slice(i, i + this.config.concurrency);
      const windowResults = await Promise.all(window.map((chunk) => this.getWorkItemsChunk(chunk, version)));
      results.push(...windowResults);
    }
    return results.flat();
  }

  private async getWorkItemsChunk(ids: number[], version: string): Promise<WorkItemRecord[]> {
    const url = `${this.credential.orgUrl.replace(/\/$/, '')}/_apis/wit/workitems?ids=${ids.join(',')}&$expand=relations&errorPolicy=Omit${
      version === 'none' ? '' : `&api-version=${version}`
    }`;
    const response = await retryWithBackoff(() =>
      this.httpClient.get(url, { headers: { Authorization: this.authHeader() } }),
    );
    // errorPolicy=Omit does not always drop a dead/deleted id from the
    // array -- ADO can instead return a `null` entry in its place
    // (confirmed live: a work item deleted directly in ADO produced a
    // null here, not an omission, crashing this whole batch with
    // "Cannot read properties of null (reading 'id')" and silently
    // defeating verifyExistingAdoIdsStillExist's stale-match check for
    // every id in the batch, not just the deleted one).
    return response.data.value
      .filter((data: unknown): data is { id: number; fields: Record<string, string>; relations?: unknown } => data != null)
      .map((data: { id: number; fields: Record<string, string>; relations?: unknown }) => ({
        id: data.id,
        type: data.fields['System.WorkItemType'] as string,
        fields: data.fields,
        parentId: parentIdFromRelations(data.relations as { rel: string; url: string }[] | undefined),
      }));
  }

  async linkParentChild(childId: number, parentId: number): Promise<void> {
    const version = await this.getApiVersion();
    const url = `${this.credential.orgUrl.replace(/\/$/, '')}/_apis/wit/workitems/${childId}${versionQueryParam(version)}`;
    const parentUrl = `${this.credential.orgUrl.replace(/\/$/, '')}/_apis/wit/workItems/${parentId}`;
    await retryWithBackoff(() =>
      this.httpClient.patch(
        url,
        [
          {
            op: 'add',
            path: '/relations/-',
            value: { rel: 'System.LinkTypes.Hierarchy-Reverse', url: parentUrl },
          },
        ],
        { headers: { Authorization: this.authHeader(), 'Content-Type': 'application/json-patch+json' } },
      ),
    );
  }

  async linkWorkItems(fromId: number, toId: number, referenceName: string): Promise<void> {
    const version = await this.getApiVersion();
    const url = `${this.credential.orgUrl.replace(/\/$/, '')}/_apis/wit/workitems/${fromId}${versionQueryParam(version)}`;
    const toUrl = `${this.credential.orgUrl.replace(/\/$/, '')}/_apis/wit/workItems/${toId}`;
    await retryWithBackoff(() =>
      this.httpClient.patch(
        url,
        [{ op: 'add', path: '/relations/-', value: { rel: referenceName, url: toUrl } }],
        { headers: { Authorization: this.authHeader(), 'Content-Type': 'application/json-patch+json' } },
      ),
    );
  }

  async queryIds(fieldMatch: Record<string, string>, project?: string): Promise<number[]> {
    const proj = project ?? this.config.adoProject;
    const version = await this.getApiVersion();
    const url = `${this.credential.orgUrl.replace(/\/$/, '')}/${proj}/_apis/wit/wiql${versionQueryParam(version)}`;
    const response = await retryWithBackoff(() =>
      this.httpClient.post(
        url,
        { query: buildWiqlQuery(fieldMatch) },
        { headers: { Authorization: this.authHeader(), 'Content-Type': 'application/json' } },
      ),
    );
    return response.data.workItems.map((item: { id: number }) => item.id);
  }

  async setFields(id: number, fields: Record<string, string>): Promise<void> {
    const version = await this.getApiVersion();
    const url = `${this.credential.orgUrl.replace(/\/$/, '')}/_apis/wit/workitems/${id}${versionQueryParam(version)}`;
    await retryWithBackoff(() =>
      this.httpClient.patch(url, toJsonPatch(fields), {
        headers: { Authorization: this.authHeader(), 'Content-Type': 'application/json-patch+json' },
      }),
    );
  }

  async discoverFields(workItemType: string): Promise<string[]> {
    const version = await this.getApiVersion();
    const url = `${this.credential.orgUrl.replace(/\/$/, '')}/${this.config.adoProject}/_apis/wit/workitemtypes/${workItemType}/fields${versionQueryParam(version)}`;
    const response = await retryWithBackoff(() =>
      this.httpClient.get(url, { headers: { Authorization: this.authHeader() } }),
    );
    return response.data.value.map((field: { referenceName: string }) => field.referenceName);
  }

  async readAreaPaths(depth: number, project?: string): Promise<AreaPathNode> {
    const proj = project ?? this.config.adoProject;
    const version = await this.getApiVersion();
    const url = `${this.credential.orgUrl.replace(/\/$/, '')}/${proj}/_apis/wit/classificationnodes/areas${versionQueryParam(version)}${version === 'none' ? '?' : '&'}$depth=${depth}`;
    const response = await retryWithBackoff(() =>
      this.httpClient.get(url, { headers: { Authorization: this.authHeader() } }),
    );
    return this.toAreaPathNode(response.data, proj);
  }

  async readIterationPaths(depth: number, project?: string): Promise<AreaPathNode> {
    const proj = project ?? this.config.adoProject;
    const version = await this.getApiVersion();
    const url = `${this.credential.orgUrl.replace(/\/$/, '')}/${proj}/_apis/wit/classificationnodes/iterations${versionQueryParam(version)}${version === 'none' ? '?' : '&'}$depth=${depth}`;
    const response = await retryWithBackoff(() =>
      this.httpClient.get(url, { headers: { Authorization: this.authHeader() } }),
    );
    return this.toAreaPathNode(response.data, proj);
  }

  async readStates(workItemType: string, project?: string): Promise<string[]> {
    const proj = project ?? this.config.adoProject;
    const version = await this.getApiVersion();
    const url = `${this.credential.orgUrl.replace(/\/$/, '')}/${proj}/_apis/wit/workitemtypes/${workItemType}/states${versionQueryParam(version)}`;
    const response = await retryWithBackoff(() =>
      this.httpClient.get(url, { headers: { Authorization: this.authHeader() } }),
    );
    return (response.data.value as { name: string }[]).map((s) => s.name);
  }

  async discoverProjects(): Promise<AdoProject[]> {
    // Collection-level endpoint -- no project segment in the URL, unlike
    // every other real call here.
    const version = await this.getApiVersion();
    const url = `${this.credential.orgUrl.replace(/\/$/, '')}/_apis/projects${versionQueryParam(version)}`;
    const response = await retryWithBackoff(() =>
      this.httpClient.get(url, { headers: { Authorization: this.authHeader() } }),
    );
    return (response.data.value as { id: string; name: string }[]).map((p) => ({ id: p.id, name: p.name }));
  }

  async discoverWorkItemTypes(project?: string): Promise<WorkItemTypeDefinition[]> {
    const proj = project ?? this.config.adoProject;
    const version = await this.getApiVersion();
    const url = `${this.credential.orgUrl.replace(/\/$/, '')}/${proj}/_apis/wit/workitemtypes${versionQueryParam(version)}`;
    const response = await retryWithBackoff(() =>
      this.httpClient.get(url, { headers: { Authorization: this.authHeader() } }),
    );
    return (response.data.value as { name: string; color: string; icon: { id: string; url: string } }[]).map((t) => ({
      name: t.name,
      color: t.color,
      icon: t.icon,
    }));
  }

  // Confirmed real bug this fixes: createWorkItem/discoverFields/readStates
  // previously received req2ado's internal "Epic"/"Feature"/"Requirement"
  // category label and sent it AS-IS as the real ADO type name -- correct
  // by coincidence only for a CMMI process template (whose Requirement-
  // category type happens to be literally named "Requirement"). An Agile
  // project's Requirement-category type is "User Story", Scrum's is
  // "Product Backlog Item", Basic's is "Issue" -- every one of those would
  // 404 against `_apis/wit/workitems/$Requirement`. `workitemtypecategories`
  // is ADO's own universal category concept (identical across every process
  // template family, including custom ones) -- `defaultWorkItemType.name` on
  // each category is the real type name to use.
  async discoverWorkItemTypeCategories(project?: string): Promise<WorkItemTypeCategoryMap> {
    const proj = project ?? this.config.adoProject;
    const version = await this.getApiVersion();
    const url = `${this.credential.orgUrl.replace(/\/$/, '')}/${proj}/_apis/wit/workitemtypecategories${versionQueryParam(version)}`;
    const response = await retryWithBackoff(() =>
      this.httpClient.get(url, { headers: { Authorization: this.authHeader() } }),
    );
    const categories = response.data.value as { referenceName: string; defaultWorkItemType: { name: string } }[];
    const byRef = new Map(categories.map((c) => [c.referenceName, c.defaultWorkItemType.name]));
    const epic = byRef.get('Microsoft.EpicCategory');
    const feature = byRef.get('Microsoft.FeatureCategory');
    const requirement = byRef.get('Microsoft.RequirementCategory');
    if (!epic || !feature || !requirement) {
      throw new Error(
        `Project ${proj}'s process template is missing an expected work-item-type category ` +
          `(Epic/Feature/Requirement) -- found: ${[...byRef.keys()].join(', ')}`,
      );
    }
    return { Epic: epic, Feature: feature, Requirement: requirement };
  }

  async getWorkItemIcon(iconId: string, color: string): Promise<WorkItemIcon> {
    const version = await this.getApiVersion();
    const base = `${this.credential.orgUrl.replace(/\/$/, '')}/_apis/wit/workitemicons/${iconId}`;
    const url = version === 'none' ? `${base}?color=${color}` : `${base}?color=${color}&api-version=${version}`;
    const response = await retryWithBackoff(() =>
      this.httpClient.get(url, {
        headers: {
          Authorization: this.authHeader(),
          // A bare `Accept: image/svg+xml` still 200s with the JSON
          // icon-reference object, not SVG bytes -- confirmed live twice
          // (once against a broken <img>, once by refetching this exact
          // endpoint with that header set and finding content-type still
          // application/json). The real azure-devops-node-api SDK's own
          // getWorkItemIconSvg (ClientApiBase.createAcceptHeader) reveals
          // why: ADO's REST content negotiation for this endpoint keys off
          // the api-version encoded INSIDE the Accept header's media-type
          // parameters (`image/svg+xml;api-version=X`), not a bare MIME
          // type -- the version query param alone isn't enough to select
          // the SVG variant. version==='none' has no api-version to embed
          // and falls back to the bare type, matching every other
          // version==='none' code path in this file (no api-version query
          // param either, in that case).
          Accept: version === 'none' ? 'image/svg+xml' : `image/svg+xml;api-version=${version}`,
        },
        responseType: 'arraybuffer',
      }),
    );
    const contentType = (response.headers['content-type'] as string | undefined) ?? 'image/svg+xml';
    return { contentType, dataBase64: Buffer.from(response.data as ArrayBuffer).toString('base64') };
  }

  /**
   * Two real ADO calls: (1) POST the raw bytes to attachments --
   * ADO's own two-step attachment flow, distinct from every other call in
   * this file since the body is raw binary, not JSON -- getting back a
   * GUID/URL reference; (2) the SAME JSON-Patch relations/- add pattern
   * linkParentChild/linkWorkItems already use, with rel: 'AttachedFile'
   * instead of a hierarchy/generic reference. `attributes.comment` uses
   * fileName so the attachment is identifiable in ADO's UI without opening
   * it.
   */
  async uploadAttachment(workItemId: number, fileName: string, dataBase64: string, mimeType: string): Promise<void> {
    const version = await this.getApiVersion();
    const uploadBase = `${this.credential.orgUrl.replace(/\/$/, '')}/${this.config.adoProject}/_apis/wit/attachments?fileName=${encodeURIComponent(fileName)}`;
    const uploadUrl = version === 'none' ? uploadBase : `${uploadBase}&api-version=${version}`;
    // ADO's attachments-create endpoint only accepts application/octet-stream
    // -- confirmed both via the official REST reference (Media Types:
    // "application/octet-stream") and live: sending the figure's real
    // mimeType (e.g. image/png) as Content-Type here 400s with "The request
    // indicated a Content-Type of ... which is not supported." `mimeType` is
    // still needed on the SECOND call below (the AttachedFile relation ADO
    // stores against the work item), just never as this upload's own header.
    const uploadResponse = await retryWithBackoff(() =>
      this.httpClient.post(uploadUrl, Buffer.from(dataBase64, 'base64'), {
        headers: { Authorization: this.authHeader(), 'Content-Type': 'application/octet-stream' },
      }),
    );
    const attachmentUrl = uploadResponse.data.url as string;
    const workItemUrl = `${this.credential.orgUrl.replace(/\/$/, '')}/_apis/wit/workitems/${workItemId}${versionQueryParam(version)}`;
    await retryWithBackoff(() =>
      this.httpClient.patch(
        workItemUrl,
        [{ op: 'add', path: '/relations/-', value: { rel: 'AttachedFile', url: attachmentUrl, attributes: { comment: fileName } } }],
        { headers: { Authorization: this.authHeader(), 'Content-Type': 'application/json-patch+json' } },
      ),
    );
  }

  private toAreaPathNode(raw: { name: string; children?: unknown[] }, pathPrefix: string): AreaPathNode {
    const path = pathPrefix;
    const children = (raw.children ?? []).map((child: any) => this.toAreaPathNode(child, `${path}\\${child.name}`));
    return { path, children };
  }

  async discoverLinkTypes(): Promise<AdoLinkType[]> {
    const version = await this.getApiVersion();
    const url = `${this.credential.orgUrl.replace(/\/$/, '')}/_apis/wit/workitemrelationtypes${versionQueryParam(version)}`;
    try {
      const response = await retryWithBackoff(() =>
        this.httpClient.get(url, { headers: { Authorization: this.authHeader() } }),
      );
      const raw = response.data.value as { referenceName: string; name: string }[];
      return raw
        .filter((t) => isWorkItemRelationType(t.referenceName))
        .map((t) => {
          const seedMatch = SEED_LINK_TYPES.find((s) => s.referenceName === t.referenceName);
          return { referenceName: t.referenceName, name: t.name, semanticHint: seedMatch?.semanticHint };
        });
    } catch {
      // Live discovery failed (network, auth, or an ADO version that doesn't
      // expose this endpoint) — fall back to the seed catalog rather than
      // failing the whole job over a discovery call that isn't the write
      // itself. Matches resolveCustomerIdField's discover-then-fallback shape.
      return SEED_LINK_TYPES;
    }
  }
}
