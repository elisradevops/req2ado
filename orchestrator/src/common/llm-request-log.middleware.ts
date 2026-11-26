import { Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

/**
 * One warning line for every model-proxy request (`/llm/...`) that did not succeed, whatever refused it. LlmController logs the refusals
 * it decides itself; this catches the ones decided before it runs or after it gave up, which left no trace in the 2026-11-26 production
 * probe (HTTP 400 with no log line, then "Connection reset by peer", while a job ran): a JSON body the parser could not read (a body cut
 * off mid-send arrives as a 400 before any handler), the bearer guard's refusal, and a caller that closed the connection before an answer.
 *
 * Registered before the body parser (main.ts), so it sees every request. Safe by construction: the route, the status, the time taken, the
 * declared body size, and the job id and stage ingestion sends. Never the user id, the bearer, the body, or any upstream text.
 */
export function llmRequestLog(logger: Pick<Logger, 'warn'> = new Logger('LlmRequests')) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const route = (req.originalUrl ?? req.url).split('?')[0];
    if (!route.startsWith('/llm/')) return next();
    const startedAt = Date.now();
    let answered = false;
    const context = (): string => {
      const header = (name: string): string | undefined => {
        const value = req.headers[name];
        return typeof value === 'string' && value.trim() ? value.trim().slice(0, 64) : undefined;
      };
      const job = header('x-req2ado-job-id');
      const stage = header('x-req2ado-stage');
      const size = header('content-length');
      return `${Date.now() - startedAt} ms` + (size ? `; body ${size} bytes` : '') + (job ? `; job ${job}` : '') + (stage ? `; stage ${stage}` : '');
    };
    res.on('finish', () => {
      answered = true;
      if (res.statusCode >= 400) logger.warn(`${req.method} ${route} answered ${res.statusCode} after ${context()}`);
    });
    res.on('close', () => {
      if (!answered) logger.warn(`${req.method} ${route} closed before an answer was sent, after ${context()}`);
    });
    next();
  };
}
