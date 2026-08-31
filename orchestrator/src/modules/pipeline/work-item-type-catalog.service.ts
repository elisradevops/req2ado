import { Injectable } from '@nestjs/common';
import { McpClient, type AdoRequestCredential } from './mcp.client';
import { DEFAULT_REQUIREMENT_TYPE_FIELD_CANDIDATES } from '../../config/requirement-type-fields';

export interface WorkItemTypeCatalogEntry {
  color: string;
  iconDataUrl: string;
}

// Icon bytes for a given (iconId, color) pair are a property of the ADO
// instance/process-template icon set, not of any one user or project --
// safe to cache process-wide. 24h mirrors the Cache-Control the old
// per-request icon proxy route used; this just makes that saving real
// (server-side, shared across every caller) instead of only ever
// benefiting one browser's own cache.
const ICON_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Resolves a project's real work-item types to their color + a ready-to-use
 * icon data URL, ENTIRELY server-side -- extracted so it can be embedded
 * directly in GET /jobs/:id's own response (JobsController) as well as
 * served standalone (AdoController), rather than the frontend making its
 * own separate follow-up request and combining it with the job response
 * client-side. Aggregation (which types exist) and icon resolution (real
 * ADO-backed byte fetches) both happen here, once, in one place -- the
 * caller gets back a plain data map with zero further round trips
 * regardless of how many types the project's process template defines.
 */
@Injectable()
export class WorkItemTypeCatalogService {
  constructor(
    private readonly mcpClient: McpClient,
    // Trailing/optional, same reasoning as JobsService's own
    // requirementTypeFieldCandidates param -- keeps every existing bare
    // `new WorkItemTypeCatalogService(mcpClient)` call site (this module's
    // own DI registration, any direct test construction) working unchanged.
    private readonly requirementTypeFieldCandidates: string[] = DEFAULT_REQUIREMENT_TYPE_FIELD_CANDIDATES,
  ) {}

  async resolve(project: string | undefined, credential?: AdoRequestCredential): Promise<Record<string, WorkItemTypeCatalogEntry>> {
    const types = await this.mcpClient.discoverWorkItemTypes(project, credential);
    const entries = await Promise.all(
      types.map(async (type): Promise<readonly [string, WorkItemTypeCatalogEntry] | null> => {
        try {
          const iconDataUrl = await this.resolveIconDataUrl(type.icon.id, type.color, credential);
          return [type.name, { color: `#${type.color}`, iconDataUrl }] as const;
        } catch {
          // One type's icon failing to resolve (a transient ADO hiccup, an
          // unrecognized icon id) must not take down the whole catalog --
          // that type just falls back to WorkItemTypeBadge's own hardcoded
          // color/icon map on the frontend, same as before this existed.
          return null;
        }
      }),
    );
    return Object.fromEntries(
      entries.filter((entry): entry is readonly [string, WorkItemTypeCatalogEntry] => entry !== null),
    );
  }

  // Category ('Epic'|'Feature'|'Requirement', the internal label
  // DryRunDiffEntry.type is always stored as -- see canNest.ts's own doc
  // comment) -> this project's real ADO type name ('User Story',
  // 'Product Backlog Item', ...). Used for DISPLAY LABELS only (e.g.
  // AddChildForm's type picker) -- never for the value sent back to a diff
  // route, which always stays the category. Fails open to the identity map
  // (same pattern as backfill.service.ts's own "Fail OPEN, never closed"
  // category set, and pipeline.worker.ts's `.catch(() => 'Requirement')`) so
  // a resolution hiccup degrades to CMMI-shaped labels, never breaks the form.
  async resolveCategoryLabels(
    project: string | undefined,
    credential?: AdoRequestCredential,
  ): Promise<Record<'Epic' | 'Feature' | 'Requirement', string>> {
    try {
      return await this.mcpClient.discoverWorkItemTypeCategories(project, credential);
    } catch {
      return { Epic: 'Epic', Feature: 'Feature', Requirement: 'Requirement' };
    }
  }

  // Surfaces the SAME resolved requirement-classification field JobsService.
  // confirm() will actually write to (JobsService.resolveRequirementTypeField),
  // so the reviewer's edit UI can show what's representable BEFORE commit --
  // not a second, independently-arrived-at answer. Fails open to null (no
  // credential, no diff yet, or the resolve itself failing) -- the same
  // "best-effort enrichment, never fails the whole job fetch" convention as
  // resolve()/resolveCategoryLabels above and JobsController.getById's own
  // try/catch around this whole enrichment block.
  async resolveRequirementClassificationField(
    project: string | undefined,
    credential?: AdoRequestCredential,
  ): Promise<{ referenceName: string; allowedValues: string[] } | null> {
    try {
      const categoryLabels = await this.resolveCategoryLabels(project, credential);
      const fields = await this.mcpClient.discoverFieldsDetailed(categoryLabels.Requirement, project, credential);
      for (const candidate of this.requirementTypeFieldCandidates) {
        const match = fields.find((f) => f.referenceName === candidate);
        if (match) {
          return { referenceName: match.referenceName, allowedValues: match.allowedValues };
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  private async resolveIconDataUrl(iconId: string, color: string, credential?: AdoRequestCredential): Promise<string> {
    const cacheKey = `${iconId}:${color}`;
    const cached = WorkItemTypeCatalogService.iconCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.dataUrl;
    }
    const icon = await this.mcpClient.getWorkItemIcon(iconId, color, credential);
    // ADO's own content negotiation for this endpoint echoes the Accept
    // header's api-version media-type parameter back onto Content-Type
    // (confirmed live: "image/svg+xml;api-version=7.1", not a bare MIME
    // type -- see realAdo.ts's getWorkItemIcon doc comment for why that
    // header shape is required at all). A `data:` URI's own media-type
    // slot must be a bare MIME type per RFC 2397; browsers happen to
    // tolerate the extra `; api-version=...` today, but it's not
    // spec-compliant and risks silently failing in a stricter parser.
    // Strip to just the type before the first `;`.
    const bareContentType = icon.contentType.split(';')[0].trim();
    const dataUrl = `data:${bareContentType};base64,${icon.dataBase64}`;
    WorkItemTypeCatalogService.iconCache.set(cacheKey, { dataUrl, expiresAt: Date.now() + ICON_CACHE_TTL_MS });
    return dataUrl;
  }

  // Static (process-wide, not per-instance): an icon id/color pair means
  // the same thing for every request this orchestrator process ever
  // serves, regardless of which user, project, or caller (AdoController vs
  // JobsController) asked -- one cache shared across all of them.
  private static readonly iconCache = new Map<string, { dataUrl: string; expiresAt: number }>();
}
