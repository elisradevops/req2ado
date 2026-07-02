/**
 * Server-side redaction pass for the orchestrator's LLM proxy — the
 * "redact-first" egress boundary from docs/architecture.md's Locked
 * Decisions. This is a direct TS port of the same five patterns already
 * used by ingestion/app/redaction/redactor.py (Phase 1's document-level
 * redaction pass) — kept identical in both languages so the same PII/secret
 * classes are caught regardless of which service touches the text last.
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
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
  return messages.map((message) => ({ ...message, content: redactText(message.content) }));
}
