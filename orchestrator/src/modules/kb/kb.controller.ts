import { BadRequestException, Body, Controller, Delete, Get, HttpException, NotFoundException, Param, Post, Put, Query } from '@nestjs/common';
import { BrowseFolderEntry, FolderIngestUrlResult, IngestedDocumentSummary, IngestUrlResult, KbService } from './kb.service';
import { IngestionHttpError, Rubric, SharePointStatus } from '../pipeline/ingestion-http.client';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SessionUser } from '../auth/session.service';

const ALLOWED_HOSTS = ['sharepoint.com', 'onedrive.com', 'sharepoint.us', 'onedrive.live.com', '1drv.ms'];

// Confirmed real bug (user-reported: "why am I getting logged out when I
// try to access the Knowledge Base page?"): the KB page auto-restores its
// last-browsed SharePoint folder on mount (KnowledgeBase.tsx), and the
// SharePoint access token has a real, expected ~1h TTL -- when it's expired,
// ingestion's Graph proxy call 401s, and this controller used to re-throw
// that AS-IS via `new HttpException(err.message, err.status)`. The
// frontend's global axios interceptor (httpClient.ts) treats ANY 401 from
// the orchestrator as "your session died" and force-logs the user out +
// redirects to /login -- it cannot distinguish "the orchestrator's own
// session guard rejected you" from "the orchestrator authenticated you
// just fine and is reporting that a DOWNSTREAM dependency's token expired."
// Both are real 401s over HTTP; only the orchestrator's own AuthGuard 401
// should ever mean "you're logged out." Remapping a downstream 401 to 424
// (Failed Dependency -- an apt, rarely-used-elsewhere code for "this
// request failed because something it depends on failed") keeps a real,
// distinguishable status the frontend's own KnowledgeBase.tsx error mapping
// (describeIngestError) already renders as "SharePoint token expired," now
// without also nuking the user's real, valid orchestrator session.
function mapIngestionErrorStatus(status: number): number {
  return status === 401 ? 424 : status;
}

@Controller('kb')
export class KbController {
  constructor(private readonly kbService: KbService) {}

  @Get('sharepoint/status')
  async sharePointStatus(): Promise<SharePointStatus> {
    return this.kbService.getSharePointStatus();
  }

  @Post('sharepoint/reconnect')
  async reconnectSharePoint(
    @CurrentUser() user: SessionUser,
    @Body('token') token: string | undefined,
  ): Promise<SharePointStatus> {
    if (!token) {
      throw new BadRequestException('token is required');
    }
    return this.kbService.reconnectSharePointToken(token, user.userId);
  }

  @Post('ingest-url')
  async ingestUrl(
    @CurrentUser() user: SessionUser,
    @Body('url') url: string | undefined,
    @Body('docType') docType: string | undefined,
    // "retrieve" (default, omitted also means this) or "always_include" --
    // see KbVectorStore.upsert_chunk's own docstring (ingestion side).
    @Body('retrievalMode') retrievalMode?: string,
  ): Promise<IngestUrlResult> {
    if (!url) {
      throw new BadRequestException('url is required');
    }
    if (!this.isAllowedHost(url)) {
      throw new BadRequestException('url must be a SharePoint/OneDrive URL');
    }
    try {
      return await this.kbService.ingestUrl(url, user.userId, docType ?? null, retrievalMode ?? null);
    } catch (err) {
      if (err instanceof IngestionHttpError) {
        throw new HttpException(err.message, mapIngestionErrorStatus(err.status));
      }
      throw err;
    }
  }

  @Post('ingest-folder-url')
  async ingestFolderUrl(
    @CurrentUser() user: SessionUser,
    @Body('url') url: string | undefined,
    @Body('docType') docType: string | undefined,
    @Body('recursive') recursive?: boolean,
  ): Promise<FolderIngestUrlResult> {
    if (!url) {
      throw new BadRequestException('url is required');
    }
    if (!this.isAllowedHost(url)) {
      throw new BadRequestException('url must be a SharePoint/OneDrive URL');
    }
    try {
      return await this.kbService.ingestFolderUrl(url, user.userId, docType ?? null, recursive ?? false);
    } catch (err) {
      if (err instanceof IngestionHttpError) {
        throw new HttpException(err.message, mapIngestionErrorStatus(err.status));
      }
      throw err;
    }
  }

  // Previously accepted a caller-supplied `userId` query param -- any
  // authenticated (or, before AuthGuard existed, ANY) caller could read any
  // other user's KB document list just by passing their descriptor.
  // `user.userId` is now always the session's own identity; there's no
  // request shape left that can ask for someone else's list.
  @Get('documents')
  async listDocuments(@CurrentUser() user: SessionUser): Promise<IngestedDocumentSummary[]> {
    return this.kbService.listDocuments(user.userId);
  }

  // The rubric the session user's jobs are graded against: the categories derived from their knowledge base (or the built-in ones), each with
  // its pass condition, whether it is pinned, and what was removed. Scoped to the session: no request shape can ask for someone else's.
  @Get('rubric')
  async getRubric(@CurrentUser() user: SessionUser): Promise<Rubric> {
    return this.kbService.getRubric(user.userId);
  }

  // Pins (a category fixed, or one of the user's own) and removals; empty lists return to the derived rubric.
  @Put('rubric')
  async putRubric(
    @CurrentUser() user: SessionUser,
    @Body() body: { pinned?: { name?: unknown; passCondition?: unknown }[]; removed?: unknown },
  ): Promise<Rubric> {
    const pinned = body?.pinned ?? [];
    const removed = body?.removed ?? [];
    if (
      !Array.isArray(pinned) ||
      !Array.isArray(removed) ||
      pinned.some((p) => typeof p?.name !== 'string' || typeof p?.passCondition !== 'string') ||
      removed.some((r) => typeof r !== 'string')
    ) {
      throw new BadRequestException('pinned must be a list of {name, passCondition} and removed a list of names');
    }
    try {
      return await this.kbService.putRubric(user.userId, {
        pinned: pinned.map((p) => ({ name: p.name as string, passCondition: p.passCondition as string })),
        removed: removed as string[],
      });
    } catch (err) {
      // Ingestion refuses a list that makes no sense (a duplicate, a blank name, too many) with a 400 and the reason.
      if (err instanceof IngestionHttpError && err.status === 400) throw new BadRequestException(err.message);
      throw err;
    }
  }

  @Delete('documents/:id')
  async deleteDocument(@Param('id') id: string, @CurrentUser() user: SessionUser): Promise<{ ok: true }> {
    const deleted = await this.kbService.deleteDocument(id, user.userId);
    if (!deleted) {
      throw new NotFoundException(`Document ${id} not found`);
    }
    return { ok: true };
  }

  @Post('ingest-item')
  async ingestItem(
    @CurrentUser() user: SessionUser,
    @Body('name') name: string | undefined,
    @Body('itemId') itemId: string | undefined,
    @Body('downloadUrl') downloadUrl: string | undefined,
    @Body('relativePath') relativePath: string | undefined,
    @Body('docType') docType: string | undefined,
    @Body('retrievalMode') retrievalMode?: string,
  ): Promise<IngestUrlResult> {
    if (!name || !itemId || !downloadUrl) {
      throw new BadRequestException('name, itemId, and downloadUrl are required');
    }
    try {
      return await this.kbService.ingestItem(
        name, itemId, downloadUrl, relativePath ?? name, user.userId, docType ?? null, retrievalMode ?? null,
      );
    } catch (err) {
      if (err instanceof IngestionHttpError) {
        throw new HttpException(err.message, mapIngestionErrorStatus(err.status));
      }
      throw err;
    }
  }

  @Get('browse-folder')
  async browseFolder(
    @CurrentUser() user: SessionUser,
    @Query('url') url: string | undefined,
    @Query('path') path: string | undefined,
  ): Promise<BrowseFolderEntry[]> {
    if (!url) {
      throw new BadRequestException('url is required');
    }
    if (!this.isAllowedHost(url)) {
      throw new BadRequestException('url must be a SharePoint/OneDrive URL');
    }
    try {
      return await this.kbService.browseFolder(url, user.userId, path ?? '');
    } catch (err) {
      if (err instanceof IngestionHttpError) {
        throw new HttpException(err.message, mapIngestionErrorStatus(err.status));
      }
      throw err;
    }
  }

  @Get('browse-children')
  async browseChildren(
    @CurrentUser() user: SessionUser,
    @Query('driveId') driveId: string | undefined,
    @Query('itemId') itemId: string | undefined,
    @Query('path') path: string | undefined,
  ): Promise<BrowseFolderEntry[]> {
    if (!driveId || !itemId) {
      throw new BadRequestException('driveId and itemId are required');
    }
    try {
      return await this.kbService.browseChildren(driveId, itemId, user.userId, path ?? '');
    } catch (err) {
      if (err instanceof IngestionHttpError) {
        throw new HttpException(err.message, mapIngestionErrorStatus(err.status));
      }
      throw err;
    }
  }

  private isAllowedHost(url: string): boolean {
    if (!url.startsWith('http')) {
      return false;
    }
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      return false;
    }
    return ALLOWED_HOSTS.some((allowed) => host === allowed || host.endsWith('.' + allowed));
  }
}
