import { Injectable } from '@nestjs/common';
import { McpClient, type AdoRequestCredential } from './mcp.client';

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
  constructor(private readonly mcpClient: McpClient) {}

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
