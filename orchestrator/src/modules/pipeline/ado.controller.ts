import { Controller, DefaultValuePipe, Get, Headers, ParseIntPipe, Query } from '@nestjs/common';
import { McpClient, type AdoProject } from './mcp.client';
import { readAdoCredential } from './credential.util';
import type { AreaPathNode } from './area-path.types';

@Controller('ado')
export class AdoController {
  constructor(private readonly mcpClient: McpClient) {}

  @Get('area-paths')
  async getAreaPaths(
    @Headers('x-ado-org-url') orgUrl: string | undefined,
    @Headers('x-ado-pat') pat: string | undefined,
    @Query('depth', new DefaultValuePipe(5), ParseIntPipe) depth: number,
    @Query('project') project: string | undefined,
  ): Promise<AreaPathNode> {
    const credential = readAdoCredential(orgUrl, pat);
    return this.mcpClient.readAreaPaths(depth, project, credential) as Promise<AreaPathNode>;
  }

  @Get('projects')
  async getProjects(
    @Headers('x-ado-org-url') orgUrl: string | undefined,
    @Headers('x-ado-pat') pat: string | undefined,
  ): Promise<AdoProject[]> {
    const credential = readAdoCredential(orgUrl, pat);
    return this.mcpClient.discoverProjects(credential);
  }
}
