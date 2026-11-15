import { describe, it, expect } from 'vitest';
import { formatSharePointExpiry } from './sharePointStatus';

describe('formatSharePointExpiry', () => {
  it('has nothing to say without a time, and says expired at or past zero', () => {
    expect(formatSharePointExpiry(null)).toBeNull();
    expect(formatSharePointExpiry(0)).toBe('expired');
    expect(formatSharePointExpiry(-30)).toBe('expired');
  });

  it('says "under a minute" for a few seconds', () => {
    expect(formatSharePointExpiry(20)).toBe('expires in under a minute');
  });

  it('counts minutes up to an hour', () => {
    expect(formatSharePointExpiry(60)).toBe('expires in 1 minute');
    expect(formatSharePointExpiry(47 * 60)).toBe('expires in 47 minutes');
    expect(formatSharePointExpiry(59 * 60)).toBe('expires in 59 minutes');
  });

  it('counts hours past an hour, not "897 minutes"', () => {
    expect(formatSharePointExpiry(60 * 60)).toBe('expires in about 1 h');
    expect(formatSharePointExpiry(897 * 60)).toBe('expires in about 15 h');
    expect(formatSharePointExpiry(90 * 60)).toBe('expires in about 2 h');
  });
});
