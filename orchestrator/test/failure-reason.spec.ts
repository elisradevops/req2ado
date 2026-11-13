import { classifyFailure, describeFailure, FAILURE_CLASSES } from '../src/modules/pipeline/failure-reason';

describe('describeFailure', () => {
  it('adds the network cause that Node hides behind "fetch failed"', () => {
    const cause = Object.assign(new Error('Headers Timeout Error'), { code: 'UND_ERR_HEADERS_TIMEOUT' });
    const error = Object.assign(new TypeError('fetch failed'), { cause });
    expect(describeFailure(error)).toBe('fetch failed (UND_ERR_HEADERS_TIMEOUT: Headers Timeout Error)');
  });

  it('follows a chain of causes and stops at a sensible depth', () => {
    let error: Error = new Error('root');
    for (let i = 0; i < 10; i++) error = Object.assign(new Error(`level ${i}`), { cause: error });
    expect(describeFailure(error).split(' <- ').length).toBeLessThanOrEqual(4);
  });

  it('is plain for an error without a cause, for non-errors, and never throws', () => {
    expect(describeFailure(new Error('boom'))).toBe('boom');
    expect(describeFailure('text')).toBe('text');
    expect(describeFailure(undefined)).toBe('unknown error');
    const hostile = { get message(): string { throw new Error('no'); } };
    expect(() => describeFailure(hostile)).not.toThrow();
  });

  it('keeps the reason short and free of line breaks', () => {
    expect(describeFailure(new Error(`a\nb ${'x'.repeat(2000)}`)).length).toBeLessThanOrEqual(500);
    expect(describeFailure(new Error('a\nb'))).toBe('a b');
  });
});

describe('classifyFailure', () => {
  const networkError = (code: string, message: string) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(message), { code }) });

  it('names a cut connection, whichever way Node words it', () => {
    expect(classifyFailure(networkError('UND_ERR_SOCKET', 'other side closed'))).toBe('connection_reset');
    expect(classifyFailure(new Error('read ECONNRESET'))).toBe('connection_reset');
    expect(classifyFailure(new Error('terminated (UND_ERR_SOCKET: other side closed)'))).toBe('connection_reset');
  });

  it('names a timeout', () => {
    expect(classifyFailure(networkError('UND_ERR_HEADERS_TIMEOUT', 'Headers Timeout Error'))).toBe('timeout');
    expect(classifyFailure(new Error('the request timed out'))).toBe('timeout');
  });

  it('names a refused request only from a status or the words, never from a bare number', () => {
    expect(classifyFailure(new Error('Request failed with status code 401'))).toBe('refused');
    expect(classifyFailure(new Error('Forbidden'))).toBe('refused');
    expect(classifyFailure(new Error('Updated item 403 of 500'))).toBe('unknown');
  });

  it('names an answer that could not be read', () => {
    expect(classifyFailure(new SyntaxError('Unexpected token < in JSON at position 0'))).toBe('unreadable_response');
  });

  it('says unknown for everything else, and never throws on a hostile value', () => {
    expect(classifyFailure(new Error('something odd'))).toBe('unknown');
    expect(classifyFailure(undefined)).toBe('unknown');
    expect(classifyFailure({ get message(): string { throw new Error('no'); } })).toBe('unknown');
  });

  it('only ever returns a class that is listed', () => {
    for (const error of [new Error('x'), new Error('ECONNRESET'), new Error('timeout')]) expect(FAILURE_CLASSES).toContain(classifyFailure(error));
  });
});
