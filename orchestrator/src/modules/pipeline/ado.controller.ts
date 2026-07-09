import { Controller, Get, Headers, Query } from '@nestjs/common';
import { McpClient } from './mcp.client';
import { readAdoCredential } from './credential.util';
import type { AreaPathNode } from './area-path.types';

@Controller('ado')
export class AdoController {
  constructor(private readonly mcpClient: McpClient) {}

  @Get('area-paths')
  async getAreaPaths(
    @Headers('x-ado-org-url') orgUrl: string | undefined,
    @Headers('x-ado-pat') pat: string | undefined,
    @Query('depth') depth?: number,
  ): Promise<AreaPathNode> {
    const credential = readAdoCredential(orgUrl, pat);
    return this.mcpClient.readAreaPaths(depth ?? 5, credential) as Promise<AreaPathNode>;
  }
}
