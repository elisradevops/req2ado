import { Controller, DefaultValuePipe, Get, ParseIntPipe, Query } from '@nestjs/common';
import { McpClient, type AdoProject } from './mcp.client';
import type { AreaPathNode } from './area-path.types';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SessionUser } from '../auth/session.service';
import { AdoCredentialResolver } from '../auth/ado-credential.resolver';
import { WorkItemTypeCatalogService, type WorkItemTypeCatalogEntry } from './work-item-type-catalog.service';

type CategoryLabels = Record<'Epic' | 'Feature' | 'Requirement', string>;
const DEFAULT_LABELS: CategoryLabels = { Epic: 'Epic', Feature: 'Feature', Requirement: 'Requirement' };

export interface AdoStatus {
  // `invalid`: Azure DevOps answered and refused the saved credential (401/403), so only a new PAT helps. `unreachable`: no usable answer
  // (network, certificate, timeout, a server error), where retrying or fixing the connection helps and a new PAT does not.
  status: 'not_configured' | 'valid' | 'invalid' | 'unreachable';
}

// The status code does not survive the MCP round trip as a field, but the error text carries it ("... probe failed: 401 at <url>", "...
// failed with status 401"). Only a whole 401 or 403 counts, so a network or certificate message is never taken for a bad credential.
const REJECTED_CREDENTIAL = /(?:failed: |status(?: code)? )(?:401|403)\b(?!\d)/;

export function classifyAdoFailure(error: unknown): 'invalid' | 'unreachable' {
  const message = error instanceof Error ? error.message : String(error);
  return REJECTED_CREDENTIAL.test(message) ? 'invalid' : 'unreachable';
}

@Controller('ado')
export class AdoController {
  constructor(
    private readonly mcpClient: McpClient,
    private readonly adoCredentialResolver: AdoCredentialResolver,
    // Optional so a controller built without it (older tests) still serves the other routes; work-item-types then answers the fallback.
    private readonly workItemTypeCatalogService?: WorkItemTypeCatalogService,
  ) {}

  /**
   * The project's work-item types as Azure DevOps draws them (colour and icon, by real type name) and which real names stand for Epic,
   * Feature and Requirement, read with the user's own credential: the new-job page's tree draws the same icons the review tree does
   * (owner finding, 2026-11-26). Best effort: no project, no credential or a failed read answers an empty catalog, and the page keeps
   * its built-in icons.
   */
  @Get('work-item-types')
  async getWorkItemTypes(
    @CurrentUser() user: SessionUser,
    @Query('project') project: string | undefined,
  ): Promise<{ catalog: Record<string, WorkItemTypeCatalogEntry>; labels: CategoryLabels }> {
    const fallback = { catalog: {}, labels: { ...DEFAULT_LABELS } };
    if (!project || !this.workItemTypeCatalogService) return fallback;
    const credential = await this.adoCredentialResolver.resolve(user.userId);
    if (!credential) return fallback;
    const [catalog, labels] = await Promise.all([
      this.workItemTypeCatalogService.resolve(project, credential).catch(() => ({})),
      this.workItemTypeCatalogService.resolveCategoryLabels(project, credential).catch(() => ({ ...DEFAULT_LABELS })),
    ]);
    return { catalog, labels };
  }

  // Cheap check for the shell's connection status -- reuses discoverProjects
  // (already the lightest real ADO call this controller makes) rather than
  // adding a dedicated ping tool. A rejected credential (401/403, read from
  // the error text, see classifyAdoFailure) is told apart from an unreachable
  // server, as SharePointStatus does.
  @Get('status')
  async getStatus(@CurrentUser() user: SessionUser): Promise<AdoStatus> {
    const credential = await this.adoCredentialResolver.resolve(user.userId);
    if (!credential) {
      return { status: 'not_configured' };
    }
    try {
      await this.mcpClient.discoverProjects(credential);
      return { status: 'valid' };
    } catch (error) {
      return { status: classifyAdoFailure(error) };
    }
  }

  @Get('area-paths')
  async getAreaPaths(
    @CurrentUser() user: SessionUser,
    @Query('depth', new DefaultValuePipe(5), ParseIntPipe) depth: number,
    @Query('project') project: string | undefined,
  ): Promise<AreaPathNode> {
    const credential = await this.adoCredentialResolver.resolve(user.userId);
    return this.mcpClient.readAreaPaths(depth, project, credential) as Promise<AreaPathNode>;
  }

  @Get('iteration-paths')
  async getIterationPaths(
    @CurrentUser() user: SessionUser,
    @Query('depth', new DefaultValuePipe(5), ParseIntPipe) depth: number,
    @Query('project') project: string | undefined,
  ): Promise<AreaPathNode> {
    const credential = await this.adoCredentialResolver.resolve(user.userId);
    return this.mcpClient.readIterationPaths(depth, project, credential) as Promise<AreaPathNode>;
  }

  @Get('states')
  async getStates(
    @CurrentUser() user: SessionUser,
    @Query('workItemType') workItemType: string,
    @Query('project') project: string | undefined,
  ): Promise<string[]> {
    const credential = await this.adoCredentialResolver.resolve(user.userId);
    // Confirmed real bug: the wizard's caller sends req2ado's internal
    // category label ("Requirement"), which previously went straight to ADO
    // as the literal type name -- 404s on any non-CMMI process template
    // (Agile's Requirement-category type is "User Story", Scrum's is
    // "Product Backlog Item"). Translated here, once, server-side, so the
    // frontend's contract (send the category label) doesn't need to change.
    const categories = await this.mcpClient.discoverWorkItemTypeCategories(project, credential);
    const realWorkItemType = categories[workItemType as keyof typeof categories] ?? workItemType;
    return this.mcpClient.readStates(realWorkItemType, project, credential);
  }

  @Get('projects')
  async getProjects(@CurrentUser() user: SessionUser): Promise<AdoProject[]> {
    const credential = await this.adoCredentialResolver.resolve(user.userId);
    return this.mcpClient.discoverProjects(credential);
  }

}
