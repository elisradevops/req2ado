/**
 * Server-side redaction pass for the orchestrator's LLM proxy — the
 * "redact-first" egress boundary from docs/architecture.md's Locked
 * Decisions. This is a direct TS port of the same five patterns already
 * used by ingestion/app/redaction/redactor.py (Phase 1's document-level
 * redaction pass) — kept identical in both languages so the same PII/secret
 * classes are caught regardless of which service touches the text last.
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  // Optional: an assistant message that ISSUES tool calls (see tool_calls
  // below) commonly carries no content at all -- only a 'tool' message
  // (the executed tool's result) or a plain system/user/assistant turn is
  // guaranteed to have one.
  content?: string;
  // The same content split into text parts, set when the caller marked where its stable prefix ends (a prompt-cache breakpoint):
  // `content` is always the parts joined. Only the redaction and the outbound request read it.
  parts?: Array<{ text: string; cache?: boolean }>;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

const PATTERNS: RegExp[] = [
  /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, // email
  /https?:\/\/[^\s]+/g, // url
  /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g, // guid
  /\b[a-zA-Z0-9-]+\.(?:internal|corp|local)\.[a-zA-Z]{2,}\b/g, // hostname
  /\b(?:PN|P\/N)-[A-Za-z0-9-]+\b/g, // part number
];

export function redactText(text: string): string {
  return PATTERNS.reduce((redacted, pattern) => redacted.replace(pattern, '<redacted>'), text);
}

export function redactMessages(messages: ChatMessage[]): ChatMessage[] {
  // content is absent on an assistant message that only carries tool_calls
  // (see ChatMessage above) -- nothing to redact in that case.
  return messages.map((message) => {
    if (message.parts) {
      // Each part on its own, so a cache breakpoint stays where the caller put it; the content stays the parts joined.
      const parts = message.parts.map((part) => ({ ...part, text: redactText(part.text) }));
      return { ...message, parts, content: parts.map((part) => part.text).join('') };
    }
    return message.content !== undefined ? { ...message, content: redactText(message.content) } : message;
  });
}
