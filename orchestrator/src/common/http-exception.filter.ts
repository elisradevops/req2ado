import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import type { Request, Response } from 'express';

/**
 * Keeps NestJS's default error body (`statusCode`, `message`, `error`) so
 * existing clients keep working, and adds `path` so the UI's error-details
 * dialog can say which route failed. With EXPOSE_ERROR_DETAILS=true it also
 * includes this process's `stack` and any upstream (ingestion) traceback
 * attached by a handler as `upstreamTraceback`. Off by default: stacks expose
 * internal paths and code structure. Only HttpExceptions are handled here;
 * anything else still reaches Nest's default handler (and its logging).
 */
@Catch(HttpException)
export class HttpExceptionFilter implements ExceptionFilter {
  constructor(private readonly exposeDetails: () => boolean = () => process.env.EXPOSE_ERROR_DETAILS === 'true') {}

  catch(exception: HttpException, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const status = exception.getStatus();
    const raw = exception.getResponse();
    const base: Record<string, unknown> =
      typeof raw === 'string' ? { statusCode: status, message: raw } : { ...(raw as Record<string, unknown>) };
    const { upstreamTraceback, ...body } = base;
    const expose = this.exposeDetails();
    response.status(status).json({
      ...body,
      path: request.originalUrl ?? request.url,
      ...(expose ? { stack: exception.stack, ...(upstreamTraceback ? { upstreamTraceback } : {}) } : {}),
    });
  }
}
