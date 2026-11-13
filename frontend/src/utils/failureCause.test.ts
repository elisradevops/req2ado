import { describe, it, expect } from 'vitest';
import { describeFailureCause, failureAuditMessage } from './failureCause';

describe('failureAuditMessage', () => {
  it('takes the newest "Pipeline failed:" audit line and strips the prefix', () => {
    const entries = [
      { message: 'Job submitted: a.docx' },
      { message: 'Pipeline failed: first attempt' },
      { message: 'Pipeline failed: terminated (UND_ERR_SOCKET: other side closed)' },
    ];
    expect(failureAuditMessage(entries)).toBe('terminated (UND_ERR_SOCKET: other side closed)');
  });

  it('is null when no audit line reports a failure', () => {
    expect(failureAuditMessage([{ message: 'Job submitted: a.docx' }])).toBeNull();
    expect(failureAuditMessage([])).toBeNull();
  });
});

describe('describeFailureCause', () => {
  it('names a cut connection in plain words and keeps the raw text for those who want it', () => {
    const cause = describeFailureCause('terminated (UND_ERR_SOCKET: other side closed)');
    expect(cause.summary).toBe('The connection was cut during the run.');
    expect(cause.detail).toBe('terminated (UND_ERR_SOCKET: other side closed)');
  });

  it('names a timeout', () => {
    expect(describeFailureCause('fetch failed [UND_ERR_HEADERS_TIMEOUT: Headers Timeout Error]').summary).toBe('A step took too long to answer.');
    expect(describeFailureCause('ETIMEDOUT').summary).toBe('A step took too long to answer.');
  });

  it('names a refused request', () => {
    expect(describeFailureCause('Request failed with status code 401').summary).toBe('A request was refused: a sign-in or permission problem.');
  });

  it('names an unreadable answer', () => {
    expect(describeFailureCause('Unexpected token < in JSON at position 0').summary).toBe('A response could not be read.');
  });

  it('does not invent a cause for an error it does not recognise: it says so and shows the raw text', () => {
    const cause = describeFailureCause('something odd happened');
    expect(cause.summary).toBe('The run stopped with an error.');
    expect(cause.detail).toBe('something odd happened');
  });

  it('handles an empty message', () => {
    expect(describeFailureCause('').summary).toBe('The run stopped with an error.');
    expect(describeFailureCause('').detail).toBe('');
  });
  it('does not blame the model for what the text does not show, and does not read a number as a status code', () => {
    // A bare 403 or 401 inside other text (an item number, a count) is not a refusal.
    expect(describeFailureCause('Updated item 403 of 500').summary).toBe('The run stopped with an error.');
    expect(describeFailureCause('Section 401 produced no output').summary).toBe('The run stopped with an error.');
    // The summaries say "a step" or "a request", never "the model": the failing call may be Azure DevOps or SharePoint.
    for (const raw of ['ETIMEDOUT', 'UND_ERR_SOCKET', 'status code 403', 'Unexpected token < in JSON']) {
      expect(describeFailureCause(raw).summary).not.toMatch(/model/i);
    }
  });
});
