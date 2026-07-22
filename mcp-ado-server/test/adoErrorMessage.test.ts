import { describe, it, expect } from 'vitest';
import { adoErrorMessage } from '../src/backends/adoErrorMessage';

describe('adoErrorMessage', () => {
  it('extracts the ADO error message from response.data.message', () => {
    const error = { response: { status: 400, data: { message: 'TF401320: The work item type does not exist.' } } };
    expect(adoErrorMessage(error)).toBe(
      'ADO request failed with status 400: TF401320: The work item type does not exist.',
    );
  });

  it('handles a plain-string response body', () => {
    const error = { response: { status: 400, data: 'Bad Request' } };
    expect(adoErrorMessage(error)).toBe('ADO request failed with status 400: Bad Request');
  });

  it('falls back to just the status when the body has no message field', () => {
    const error = { response: { status: 500, data: {} } };
    expect(adoErrorMessage(error)).toBe('ADO request failed with status 500');
  });

  it('falls back to error.message when there is no response at all (e.g. network error)', () => {
    const error = new Error('connect ECONNREFUSED');
    expect(adoErrorMessage(error)).toBe('connect ECONNREFUSED');
  });

  it('falls back to String(error) for a non-Error, non-response thrown value', () => {
    expect(adoErrorMessage('boom')).toBe('boom');
  });
});
