// The figure-attachment phase of JobsService.confirm(): uploads each stored figure to the work item that cites it. Best-effort end to end -- a failed
// upload leaves its row stored for the manual attach route and never fails the confirm. Function module: no I/O beyond the injected prisma and mcp client.

import type { PrismaClient } from '@prisma/client';
import type { McpClient } from './mcp.client';
import { mapWithConcurrency } from './map-with-concurrency';
import { selectFiguresToAttach, type WritePlanEntry } from './write-plan';

// Task 6: mimeType -> file extension for the ADO attachment filename below
// -- JobFigureFile.mimeType is whatever ingestion's own image-sniffing
// reported (see main.py's _sniff_image_mime_type / _rasterize_for_vision),
// so this must cover every raster format ingestion can actually produce,
// not just PNG. Falls back to 'png' for an unrecognized mimeType, matching
// the extension every figure was hardcoded to before this task -- an
// unrecognized type is no worse off than the old behavior.
const FIGURE_MIME_TO_EXTENSION: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'image/tiff': 'tiff',
};

// Builds a human-readable ADO attachment filename from a figure's own name
// (Task 5), sanitized to characters ADO accepts, with the real extension
// derived from the figure's stored mimeType -- replaces the previous
// unconditional `${figureId}.png` (meaningless to a reviewer in ADO's own
// attachment list, and silently wrong whenever mimeType wasn't actually
// PNG). Falls back to `${figureId}.{ext}` when the figure has no name, so
// an unnamed figure's filename is unchanged from before this task (still
// gets the CORRECT extension, though -- that half of the fix applies
// unconditionally). The human figure number in the filename is derived
// from figureId's own numeric suffix ("f11" -> 12), the same 0-based-id/
// 1-based-index relationship FigureDescriptionEntry.figureId's own doc
// comment establishes -- not a second, independently-computed index that
// could drift from it.
export function buildFigureAttachmentFilename(figureId: string, name: string | null | undefined, mimeType: string): string {
  const extension = FIGURE_MIME_TO_EXTENSION[mimeType] ?? 'png';
  const fallback = `${figureId}.${extension}`;
  if (!name) return fallback;
  const sanitized = name
    .trim()
    .replace(/[^a-zA-Z0-9\- ]+/g, '') // drop anything not alphanumeric/dash/space
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
  if (!sanitized) return fallback;
  const figureNumberMatch = /^f(\d+)$/.exec(figureId);
  const figureNumber = figureNumberMatch ? Number(figureNumberMatch[1]) + 1 : null;
  return figureNumber !== null ? `Figure-${figureNumber}-${sanitized}.${extension}` : `${sanitized}.${extension}`;
}

// Short, credential-free reason for the job's audit trail: ADO/MCP error text can carry request URLs, auth headers and the PAT itself.
export function sanitizeFigureError(message: string, pat?: string): string {
  let text = message.replace(/https?:\/\/\S+/gi, '[url]').replace(/\b(?:Bearer|Basic)\s+\S+/gi, '***');
  if (pat) text = text.split(pat).join('***');
  return text.replace(/[A-Za-z0-9+/=]{40,}/g, '***').replace(/\s+/g, ' ').trim().slice(0, 120);
}

export interface AttachFiguresDeps {
  prisma: PrismaClient;
  mcpClient: McpClient;
  writeConcurrency: number;
}

export interface AttachFiguresArgs<T extends WritePlanEntry> {
  jobId: string;
  diff: T[];
  isExcluded: (entry: T) => boolean;
  eligibleAdoIdByLocalId: Map<string, number>;
  figureNameByFigureId: Map<string, string | null>;
  project: Parameters<McpClient['uploadAttachment']>[4];
  credential?: Parameters<McpClient['uploadAttachment']>[5];
}

export async function attachFigures<T extends WritePlanEntry>(
  deps: AttachFiguresDeps,
  args: AttachFiguresArgs<T>,
): Promise<{ attached: number; failed: { figureId: string; adoId: number }[] }> {
  const { prisma, mcpClient, writeConcurrency } = deps;
  const { jobId, diff, isExcluded, eligibleAdoIdByLocalId, figureNameByFigureId, project, credential } = args;
  const failedFigures: { figureId: string; adoId: number }[] = [];
  let attached = 0;
  const figureFiles = await prisma.jobFigureFile.findMany({ where: { jobId } });
  if (figureFiles.length === 0) return { attached, failed: failedFigures };
    const figureFileByFigureId = new Map(figureFiles.map((f) => [f.figureId, f]));
    // Grouped by adoId, one group per work item -- concurrency runs
    // ACROSS groups (different work items in flight at once), never
    // WITHIN a group. Real, confirmed bug this fixes: two
    // figure-attachment PATCHes racing against the SAME work item
    // both read its revision before either commits, so the second
    // to land 409s with ADO's own optimistic-concurrency check
    // (TF26071 "changed by someone else since you opened it") --
    // confirmed live, 8 of 18 figures on one real Feature lost this
    // way, silently (the existing per-figure catch below only
    // logs). Serializing uploads to the SAME work item removes the
    // self-race entirely; an external actor editing the same item
    // concurrently is a separate, pre-existing, accepted risk this
    // fix does not attempt to cover.
    const toAttachByAdoId = selectFiguresToAttach(diff, isExcluded, eligibleAdoIdByLocalId, figureFileByFigureId);
    let firstFigureError = '';
    let firstFigureErrorSizeRelated = false;
    await mapWithConcurrency(Array.from(toAttachByAdoId.entries()), writeConcurrency, async ([adoId, figureIds]) => {
      for (const figureId of figureIds) {
        const figureFile = figureFileByFigureId.get(figureId);
        if (!figureFile) continue;
        // Best-effort per figure too: one failed attachment must not
        // stop the rest of this job's figures from attaching.
        try {
          await mcpClient.uploadAttachment(
            adoId,
            buildFigureAttachmentFilename(figureId, figureNameByFigureId.get(figureId) ?? null, figureFile.mimeType),
            Buffer.from(figureFile.bytes).toString('base64'),
            figureFile.mimeType,
            project,
            credential,
          );
        } catch (error) {
          // eslint-disable-next-line no-console -- operational visibility for a best-effort path, not app logging
          console.error(`Figure attachment failed for ADO work item ${adoId}, figure ${figureId}:`, error);
          if (failedFigures.length === 0) {
            firstFigureError = sanitizeFigureError(error instanceof Error ? error.message : String(error), credential?.pat);
            firstFigureErrorSizeRelated = /size|too large|limit|413/i.test(firstFigureError);
          }
          failedFigures.push({ figureId, adoId });
          continue;
        }
        attached += 1;
        // The upload is done: a failed row removal (e.g. already removed) is not an attachment failure and must not be reported as one.
        try {
          await prisma.jobFigureFile.deleteMany({ where: { id: figureFile.id } });
        } catch (error) {
          // eslint-disable-next-line no-console -- operational visibility for a best-effort path, not app logging
          console.error(`Figure row removal failed for ADO work item ${adoId}, figure ${figureId}:`, error);
        }
      }
    });
    // Also on the job's audit trail so the reviewer sees it (the figure rows stay stored for the manual attach route). Best-effort.
    if (failedFigures.length > 0) {
      try {
        const listed = failedFigures.slice(0, 5).map((f) => `${f.figureId} on #${f.adoId}`).join(', ');
        const rest = failedFigures.length > 5 ? ` and ${failedFigures.length - 5} more` : '';
        await prisma.auditEntry.create({
          data: {
            jobId,
            message: `${failedFigures.length} figure attachment(s) failed (${firstFigureErrorSizeRelated ? 'ADO may limit attachment size: the Azure DevOps Server default is 4 MB; ' : ''}first error: ${firstFigureError}): ${listed}${rest}; add them from the item's Figures section`,
          },
        });
      } catch {
        // The audit write is a courtesy on top of an already-best-effort path.
      }
    }
  return { attached, failed: failedFigures };
}
