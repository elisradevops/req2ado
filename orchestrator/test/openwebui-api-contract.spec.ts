import {
  chatCompletedRequestSchema,
  chatCompletionChunkSchema,
  chatCompletionResponseSchema,
  errorMessageFromBody,
  modelsResponseSchema,
  retryAfterMsFromHeaders,
} from '../src/modules/llm/openwebui-api';

// Shapes from the Open WebUI API reference (api-endpoints, api-flow, filter pages) and from errors seen in prod. They
// are the mocks of what the app accepts from, and sends to, `/api/chat/completions`, `/api/models` and
// `/api/chat/completed`.

describe('chat completion response (non-streaming)', () => {
  it('accepts the documented OpenAI-compatible body', () => {
    const body = {
      id: 'chatcmpl-123',
      object: 'chat.completion',
      created: 1677652288,
      model: 'gpt-5.6-terra',
      choices: [{ index: 0, message: { role: 'assistant', content: 'The document explains...' }, finish_reason: 'stop' }],
    };
    const parsed = chatCompletionResponseSchema.parse(body);
    expect(parsed.choices[0].message.content).toBe('The document explains...');
  });

  it("accepts Open WebUI's extras: usage with input/output/total tokens, a top-level sources array, unknown fields", () => {
    const body = {
      choices: [{ message: { role: 'assistant', content: 'Here is a plan...' } }],
      usage: { prompt_tokens: 10, completion_tokens: 20, input_tokens: 10, output_tokens: 20, total_tokens: 30 },
      sources: [{ source: { id: 'f1' }, document: ['x'] }],
      something_new: true,
    };
    const parsed = chatCompletionResponseSchema.parse(body);
    expect(parsed.usage?.total_tokens).toBe(30);
    expect(parsed.sources).toHaveLength(1);
  });

  it('accepts a tool-call answer with null content and a reasoning field', () => {
    const body = {
      choices: [
        {
          message: { role: 'assistant', content: null, reasoning_content: 'thinking', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }] },
          finish_reason: 'tool_calls',
        },
      ],
    };
    expect(chatCompletionResponseSchema.parse(body).choices[0].message.content).toBeNull();
  });

  it('rejects an answer with no choices (the empty completion the proxy returns at its time limit)', () => {
    expect(chatCompletionResponseSchema.safeParse({ choices: [] }).success).toBe(false);
    expect(chatCompletionResponseSchema.safeParse({ error: 'x' }).success).toBe(false);
  });
});

describe('streaming chunk', () => {
  it('accepts a content delta, a reasoning delta and the final usage chunk', () => {
    expect(chatCompletionChunkSchema.parse({ choices: [{ index: 0, delta: { content: 'Hel' } }] }).choices[0].delta?.content).toBe('Hel');
    expect(chatCompletionChunkSchema.safeParse({ choices: [{ delta: { reasoning_content: 'hm' } }] }).success).toBe(true);
    expect(chatCompletionChunkSchema.safeParse({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }).success).toBe(true);
  });
});

describe('error bodies and rate-limit headers', () => {
  it("reads Open WebUI's {detail} and the OpenAI-style {error:{message}} and plain text", () => {
    expect(errorMessageFromBody('{"detail":"Model not found"}')).toBe('Model not found');
    expect(errorMessageFromBody('{"error":{"message":"bad schema","type":"invalid_request_error"}}')).toBe('bad schema');
    expect(errorMessageFromBody('{"error":"quota"}')).toBe('quota');
    expect(errorMessageFromBody('upstream connect error')).toBe('upstream connect error');
    expect(errorMessageFromBody('')).toBe('');
  });

  it('reads the provider retry hint the proxy passes through, preferring milliseconds', () => {
    expect(retryAfterMsFromHeaders({ 'retry-after-ms': '1500', 'retry-after': '9' })).toBe(1500);
    expect(retryAfterMsFromHeaders({ 'retry-after': '3' })).toBe(3000);
    expect(retryAfterMsFromHeaders({ 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' }, Date.parse('2026-10-21T07:27:00Z'))).toBe(60_000);
    expect(retryAfterMsFromHeaders({})).toBeNull();
    expect(retryAfterMsFromHeaders({ 'retry-after': 'soon' })).toBeNull();
  });
});

describe('/api/models listing and /api/chat/completed', () => {
  it('a listing is { data: [entries] } and a broken entry does not hide the rest', () => {
    const parsed = modelsResponseSchema.parse({ data: [{ id: 'a' }, { name: 'no id' }, { id: 'b' }] });
    expect(parsed.data.map((entry) => entry.id)).toEqual(['a', 'b']);
  });

  it('the completed request needs the whole conversation, the assistant message id, chat_id and session_id (both may be empty)', () => {
    const ok = {
      model: 'm',
      messages: [{ role: 'user', content: 'Hello' }, { role: 'assistant', content: 'Hi' }],
      id: 'assistant-message-id',
      chat_id: '',
      session_id: '',
    };
    expect(chatCompletedRequestSchema.safeParse(ok).success).toBe(true);
    expect(chatCompletedRequestSchema.safeParse({ ...ok, id: undefined }).success).toBe(false);
    expect(chatCompletedRequestSchema.safeParse({ ...ok, messages: [] }).success).toBe(false);
  });
});
