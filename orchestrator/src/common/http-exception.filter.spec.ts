import { BadGatewayException, BadRequestException, HttpException } from '@nestjs/common';
import { HttpExceptionFilter } from './http-exception.filter';

function run(exception: HttpException, expose: boolean): { status: number; body: Record<string, unknown> } {
  let captured: { status: number; body: Record<string, unknown> } = { status: 0, body: {} };
  const response = {
    status(code: number) {
      return { json: (body: Record<string, unknown>) => (captured = { status: code, body }) };
    },
  };
  const host = {
    switchToHttp: () => ({ getResponse: () => response, getRequest: () => ({ originalUrl: '/jobs/1/rescore' }) }),
  };
  new HttpExceptionFilter(() => expose).catch(exception, host as never);
  return captured;
}

describe('HttpExceptionFilter', () => {
  it('keeps the default Nest body shape and adds path', () => {
    const { status, body } = run(new BadRequestException('nope'), false);
    expect(status).toBe(400);
    expect(body).toEqual({ message: 'nope', error: 'Bad Request', statusCode: 400, path: '/jobs/1/rescore' });
  });

  it('omits stack and upstream traceback by default', () => {
    const exception = new BadGatewayException({ statusCode: 502, message: 'm', upstreamTraceback: 'tb' });
    const { body } = run(exception, false);
    expect(body.stack).toBeUndefined();
    expect(body.upstreamTraceback).toBeUndefined();
  });

  it('includes stack and upstream traceback when exposure is on', () => {
    const exception = new BadGatewayException({ statusCode: 502, message: 'm', upstreamTraceback: 'tb' });
    const { body } = run(exception, true);
    expect(typeof body.stack).toBe('string');
    expect(body.upstreamTraceback).toBe('tb');
  });
});
