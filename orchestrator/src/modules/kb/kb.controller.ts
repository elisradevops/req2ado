import { BadRequestException, Body, Controller, Get, HttpException, Post, Query } from '@nestjs/common';
import { FolderIngestUrlResult, IngestedDocumentSummary, IngestUrlResult, KbService } from './kb.service';
import { IngestionHttpError } from '../pipeline/ingestion-http.client';

const ALLOWED_HOSTS = ['sharepoint.com', 'onedrive.com', 'sharepoint.us', 'onedrive.live.com', '1drv.ms'];

@Controller('kb')
export class KbController {
  constructor(private readonly kbService: KbService) {}

  @Post('ingest-url')
  async ingestUrl(
    @Body('url') url: string | undefined,
    @Body('areaPath') areaPath: string | undefined,
    @Body('docType') docType: string | undefined,
  ): Promise<IngestUrlResult> {
    if (!url) {
      throw new BadRequestException('url is required');
    }
    if (!areaPath) {
      throw new BadRequestException('areaPath is required');
    }
    if (!this.isAllowedHost(url)) {
      throw new BadRequestException('url must be a SharePoint/OneDrive URL');
    }
    try {
      return await this.kbService.ingestUrl(url, areaPath, docType ?? null);
    } catch (err) {
      if (err instanceof IngestionHttpError) {
        throw new HttpException(err.message, err.status);
      }
      throw err;
    }
  }

  @Post('ingest-folder-url')
  async ingestFolderUrl(
    @Body('url') url: string | undefined,
    @Body('areaPath') areaPath: string | undefined,
    @Body('docType') docType: string | undefined,
  ): Promise<FolderIngestUrlResult> {
    if (!url) {
      throw new BadRequestException('url is required');
    }
    if (!areaPath) {
      throw new BadRequestException('areaPath is required');
    }
    if (!this.isAllowedHost(url)) {
      throw new BadRequestException('url must be a SharePoint/OneDrive URL');
    }
    try {
      return await this.kbService.ingestFolderUrl(url, areaPath, docType ?? null);
    } catch (err) {
      if (err instanceof IngestionHttpError) {
        throw new HttpException(err.message, err.status);
      }
      throw err;
    }
  }

  @Get('documents')
  async listDocuments(@Query('areaPath') areaPath?: string): Promise<IngestedDocumentSummary[]> {
    return this.kbService.listDocuments(areaPath);
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
