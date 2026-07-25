import { llmChatRequestSchema } from '../src/modules/llm/llm-chat.dto';

describe('llmChatRequestSchema', () => {
  it('parses a plain system/user/assistant request unchanged (backward compat)', () => {
    const result = llmChatRequestSchema.safeParse({
      messages: [
        { role: 'system', content: 'be terse' },
        { role: 'user', content: 'hi' },
      ],
      model: 'gemma4:e4b',
      temperature: 0,
    });
    expect(result.success).toBe(true);
  });

  it('accepts an optional numCtx (Ollama runtime context window override)', () => {
    const result = llmChatRequestSchema.safeParse({
      messages: [{ role: 'user', content: 'hi' }],
      numCtx: 28000,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.numCtx).toBe(28000);
    }
  });

  it('rejects a non-positive numCtx', () => {
    const result = llmChatRequestSchema.safeParse({
      messages: [{ role: 'user', content: 'hi' }],
      numCtx: 0,
    });
    expect(result.success).toBe(false);
  });

  it('accepts optional topK/minP (Gemma4 repetition-collapse mitigation)', () => {
    const result = llmChatRequestSchema.safeParse({
      messages: [{ role: 'user', content: 'hi' }],
      topK: 50,
      minP: 0.05,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.topK).toBe(50);
      expect(result.data.minP).toBe(0.05);
    }
  });

  it('rejects a minP outside [0, 1]', () => {
    const result = llmChatRequestSchema.safeParse({
      messages: [{ role: 'user', content: 'hi' }],
      minP: 1.5,
    });
    expect(result.success).toBe(false);
  });

  it('does NOT strip tools/toolChoice (Zod default is to strip unknown keys)', () => {
    const tools = [{ type: 'function' as const, function: { name: 'query_kb', parameters: { type: 'object' } } }];
    const result = llmChatRequestSchema.safeParse({
      messages: [{ role: 'user', content: 'hi' }],
      tools,
      toolChoice: 'auto',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tools).toEqual(tools);
      expect(result.data.toolChoice).toBe('auto');
    }
  });

  it('parses an assistant message that carries tool_calls with no content', () => {
    const result = llmChatRequestSchema.safeParse({
      messages: [
        { role: 'user', content: 'what does the KB say about power rails?' },
        {
          role: 'assistant',
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'query_kb', arguments: '{"query":"power rail"}' } }],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('parses a tool-role message carrying tool_call_id + the tool result as content', () => {
    const result = llmChatRequestSchema.safeParse({
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'tool', tool_call_id: 'call_1', content: 'KB snippet text' },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a message with neither content nor tool_calls', () => {
    const result = llmChatRequestSchema.safeParse({
      messages: [{ role: 'assistant' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown tool_choice value', () => {
    const result = llmChatRequestSchema.safeParse({
      messages: [{ role: 'user', content: 'hi' }],
      toolChoice: 'bogus',
    });
    expect(result.success).toBe(false);
  });
});
