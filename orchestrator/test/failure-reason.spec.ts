import { describeFailure } from '../src/modules/pipeline/failure-reason';

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
