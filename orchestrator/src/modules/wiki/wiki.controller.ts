import { Controller, Get, Header } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';

@Controller('wiki')
export class WikiController {
  @Get()
  @Header('Content-Type', 'text/markdown')
  getUserGuide(): string {
    // docs/user-guide.md lives at the monorepo root's docs/ dir, four levels
    // up from the compiled orchestrator/dist/modules/wiki/ — read synchronously since
    // this is a small, static, infrequently-read file, not a per-request
    // I/O-bound hot path.
    return readFileSync(join(__dirname, '../../../../docs/user-guide.md'), 'utf-8');
  }
}
