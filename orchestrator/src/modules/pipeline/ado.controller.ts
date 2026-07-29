import { Controller, DefaultValuePipe, Get, ParseIntPipe, Query } from '@nestjs/common';
import { McpClient, type AdoProject } from './mcp.client';
import type { AreaPathNode } from './area-path.types';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SessionUser } from '../auth/session.service';
import { AdoCredentialResolver } from '../auth/ado-credential.resolver';

export interface AdoStatus {
  status: 'not_configured' | 'valid' | 'unreachable';
}

@Controller('ado')
export class AdoController {
  constructor(
    private readonly mcpClient: McpClient,
    private readonly adoCredentialResolver: AdoCredentialResolver,
  ) {}

  // Cheap reachability check for the shell's connection-status LED --
  // reuses discoverProjects (already the lightest real ADO call this
  // controller makes) rather than adding a dedicated ping tool. Unlike
  // SharePointStatus, this can't distinguish "credential invalid" from
  // "ADO unreachable" -- mcp.client.ts's parseToolTextResult only ever
  // throws a plain Error(message), no structured status code survives the
  // MCP round trip -- so both collapse to "unreachable" rather than
  // guessing at a distinction the data doesn't support.
  @Get('status')
  async getStatus(@CurrentUser() user: SessionUser): Promise<AdoStatus> {
    const credential = await this.adoCredentialResolver.resolve(user.userId);
    if (!credential) {
      return { status: 'not_configured' };
    }
    try {
      await this.mcpClient.discoverProjects(credential);
      return { status: 'valid' };
    } catch {
      return { status: 'unreachable' };
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
