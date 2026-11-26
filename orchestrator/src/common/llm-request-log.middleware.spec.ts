import { EventEmitter } from 'node:events';
import { llmRequestLog } from './llm-request-log.middleware';

function request(url: string, headers: Record<string, string> = {}) {
  return { originalUrl: url, url, method: 'POST', headers } as never;
}

function response() {
  const res = new EventEmitter() as EventEmitter & { statusCode: number };
  res.statusCode = 200;
  return res;
}

describe('llmRequestLog', () => {
  const run = (url: string, headers: Record<string, string> = {}) => {
    const warn = jest.fn();
    const res = response();
    const next = jest.fn();
    llmRequestLog({ warn })(request(url, headers), res as never, next);
    return { warn, res, next };
  };

  it('logs a model-proxy request answered with an error, with its job and stage but never the user id or body', () => {
    const { warn, res, next } = run('/llm/chat', {
      'x-req2ado-job-id': 'job-7',
      'x-req2ado-stage': 'study',
      'x-req2ado-user-id': 'user-secret',
      'content-length': '5120',
      authorization: 'Bearer secret',
    });
    expect(next).toHaveBeenCalled();
    res.statusCode = 400;
    res.emit('finish');
    res.emit('close');
    expect(warn).toHaveBeenCalledTimes(1);
    const line = warn.mock.calls[0][0] as string;
    expect(line).toMatch(/^POST \/llm\/chat answered 400 after \d+ ms; body 5120 bytes; job job-7; stage study$/);
    expect(line).not.toContain('user-secret');
    expect(line).not.toContain('Bearer');
  });

  it('logs a request whose caller went away before an answer', () => {
    const { warn, res } = run('/llm/chat');
    res.emit('close');
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^POST \/llm\/chat closed before an answer was sent, after \d+ ms$/));
  });

  it('stays quiet for a successful call and for routes outside the model proxy', () => {
    const ok = run('/llm/chat');
    ok.res.emit('finish');
    ok.res.emit('close');
    expect(ok.warn).not.toHaveBeenCalled();
    const other = run('/jobs/1');
    other.res.statusCode = 404;
    other.res.emit('finish');
    expect(other.warn).not.toHaveBeenCalled();
  });
});

describe('llmRequestLog in front of the JSON body parser', () => {
  it('logs the 400 the parser answers for a body it cannot read, before any handler runs', async () => {
    const express = (await import('express')).default;
    const request = (await import('supertest')).default;
    const warn = jest.fn();
    const app = express();
    app.use(llmRequestLog({ warn }));
    app.use(express.json());
    app.post('/llm/chat', (_req, res) => res.json({ ok: true }));
    await request(app).post('/llm/chat').set('content-type', 'application/json').set('x-req2ado-stage', 'study').send('{"messages": [');
    await new Promise((resolve) => setImmediate(resolve));
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^POST \/llm\/chat answered 400 after \d+ ms; body \d+ bytes; stage study$/));
  });
});
