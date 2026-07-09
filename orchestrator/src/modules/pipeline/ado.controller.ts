import { Controller, DefaultValuePipe, Get, Headers, ParseIntPipe, Query } from '@nestjs/common';
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
    @Query('depth', new DefaultValuePipe(5), ParseIntPipe) depth: number,
  ): Promise<AreaPathNode> {
    const credential = readAdoCredential(orgUrl, pat);
    return this.mcpClient.readAreaPaths(depth, credential) as Promise<AreaPathNode>;
  }
}
