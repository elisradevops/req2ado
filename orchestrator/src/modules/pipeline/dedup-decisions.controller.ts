import { BadRequestException, Controller, Get, Query, Res } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import type { Response } from 'express';
import { listDecisions, toCsv, type DecisionQuery } from './dedup-decision-log';

const OUTCOMES = ['kept_skipped', 'created_anyway', 'undecided'] as const;
const FORMATS = ['json', 'csv'] as const;

interface DecisionsQuery {
  since?: string;
  until?: string;
  jobId?: string;
  outcome?: string;
  limit?: string;
  format?: string;
}

function parseDate(name: string, value: string | undefined): Date | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new BadRequestException(`${name} must be a date, such as 2026-11-01 or 2026-11-01T00:00:00Z`);
  return parsed;
}

// Why items were (or were nearly) skipped as duplicates, kept for DEDUP_DECISION_LOG_RETENTION_MS. Open to every signed-in user, like the
// results of a job: they are the same texts anyone with access to Azure DevOps can read. Thin: the query is checked here, the work is in
// dedup-decision-log.ts.
@Controller('dedup/decisions')
export class DedupDecisionsController {
  constructor(private readonly prisma: PrismaClient) {}

  @Get()
  async list(@Query() query: DecisionsQuery, @Res({ passthrough: true }) res: Response): Promise<unknown> {
    const format = query.format ?? 'json';
    if (!(FORMATS as readonly string[]).includes(format)) throw new BadRequestException(`format must be one of ${FORMATS.join(', ')}`);
    if (query.outcome !== undefined && !(OUTCOMES as readonly string[]).includes(query.outcome)) {
      throw new BadRequestException(`outcome must be one of ${OUTCOMES.join(', ')}`);
    }
    let limit: number | undefined;
    if (query.limit !== undefined) {
      limit = Number(query.limit);
      if (!Number.isFinite(limit)) throw new BadRequestException('limit must be a number');
    }
    const decisionQuery: DecisionQuery = {
      since: parseDate('since', query.since),
      until: parseDate('until', query.until),
      jobId: query.jobId || undefined,
      outcome: query.outcome as DecisionQuery['outcome'],
      limit,
    };
    const rows = await listDecisions(this.prisma, decisionQuery);
    if (format === 'csv') {
      res.type('text/csv; charset=utf-8');
      return toCsv(rows as never);
    }
    return rows;
  }
}
