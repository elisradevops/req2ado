import { describe, it, expect } from 'vitest';
import { reconnectFailureMessage } from './sharePointReconnect';

describe('reconnectFailureMessage', () => {
  it('tells a token SharePoint refused to be rechecked apart from a check that could not happen', () => {
    const rejected = reconnectFailureMessage('invalid');
    const unreachable = reconnectFailureMessage('unreachable');
    const noAnswer = reconnectFailureMessage('error');
    expect(rejected).toMatch(/rejected that token/i);
    expect(unreachable).toMatch(/couldn.t reach SharePoint/i);
    expect(unreachable).not.toMatch(/rejected/i);
    expect(noAnswer).toMatch(/couldn.t check/i);
    expect(noAnswer).not.toMatch(/rejected/i);
    expect(new Set([rejected, unreachable, noAnswer]).size).toBe(3);
  });

  it('says nothing was saved when the check could not run, so the user does not fetch a new token for nothing', () => {
    expect(reconnectFailureMessage('unreachable')).toMatch(/nothing was saved/i);
    expect(reconnectFailureMessage('error')).toMatch(/nothing was saved/i);
  });

  it('treats any other status as a refusal', () => {
    expect(reconnectFailureMessage('not_configured')).toBe(reconnectFailureMessage('invalid'));
  });
});
