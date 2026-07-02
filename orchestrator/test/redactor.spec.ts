import { redactMessages, redactText } from '../src/modules/llm/redactor';

describe('redactText', () => {
  it('redacts email addresses', () => {
    expect(redactText('contact jane@example.com for details')).toBe('contact <redacted> for details');
  });

  it('redacts URLs', () => {
    expect(redactText('see https://internal.corp.example/doc for spec')).toBe('see <redacted> for spec');
  });

  it('redacts GUIDs', () => {
    expect(redactText('id 123e4567-e89b-12d3-a456-426614174000 assigned')).toBe('id <redacted> assigned');
  });

  it('redacts internal hostnames', () => {
    expect(redactText('deployed to host01.internal.example')).toBe('deployed to <redacted>');
  });

  it('redacts part numbers', () => {
    expect(redactText('replace PN-4471-A immediately')).toBe('replace <redacted> immediately');
  });

  it('leaves ordinary text untouched', () => {
    expect(redactText('The receiver shall scan all channels.')).toBe('The receiver shall scan all channels.');
  });

  it('redacts multiple patterns in the same string', () => {
    const input = 'contact jane@example.com about PN-100-B';
    expect(redactText(input)).toBe('contact <redacted> about <redacted>');
  });
});

describe('redactMessages', () => {
  it('redacts content in every message', () => {
    const messages = [
      { role: 'system' as const, content: 'You are a requirements assistant.' },
      { role: 'user' as const, content: 'Contact jane@example.com for the spec.' },
    ];
    const result = redactMessages(messages);
    expect(result[0].content).toBe('You are a requirements assistant.');
    expect(result[1].content).toBe('Contact <redacted> for the spec.');
  });

  it('does not mutate the input array or its objects', () => {
    const messages = [{ role: 'user' as const, content: 'jane@example.com' }];
    const result = redactMessages(messages);
    expect(messages[0].content).toBe('jane@example.com');
    expect(result).not.toBe(messages);
  });

  it('preserves role values unchanged', () => {
    const messages = [{ role: 'assistant' as const, content: 'no pii here' }];
    expect(redactMessages(messages)[0].role).toBe('assistant');
  });
});
