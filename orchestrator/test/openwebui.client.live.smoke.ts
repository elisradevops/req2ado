/**
 * Manual smoke test against a REAL local Ollama instance — not part of the
 * automated suite (deliberately not named *.spec.ts so Jest's default
 * testMatch skips it; CI never runs this).
 *
 * Prerequisites: `ollama serve` running locally with a chat-capable model
 * pulled (e.g. `ollama pull llama3.1`).
 *
 * Run manually with: npx ts-node test/openwebui.client.live.smoke.ts
 */
import { OpenWebUiClient } from '../src/modules/llm/openwebui.client';

async function main(): Promise<void> {
  const client = new OpenWebUiClient({
    LLM_BASE_URL: process.env.LLM_BASE_URL ?? 'http://localhost:11434/v1',
    LLM_CHAT_MODEL: process.env.LLM_CHAT_MODEL ?? 'llama3.1',
    LLM_TRUSTED_LOCAL: true, // local dev smoke test — no redaction needed for a hello-world prompt
  });

  const result = await client.chat([{ role: 'user', content: 'Reply with exactly: OK' }], { temperature: 0 });
  console.log('Response from local Ollama:', result);
}

main().catch((err) => {
  console.error('Live Ollama smoke test failed:', err);
  process.exitCode = 1;
});
