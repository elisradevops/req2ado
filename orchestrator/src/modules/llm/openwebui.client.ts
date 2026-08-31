import { Injectable } from '@nestjs/common';
import OpenAI from 'openai';
import type { LlmChatOptions, LlmChatResult, LlmClient, LlmResponseSchema, LlmStreamChunk } from './llm-client.interface';
import { redactMessages, redactText, type ChatMessage } from './redactor';
import { fetchWithRetry } from './retryWithBackoff';

function buildResponseFormat(opts: LlmChatOptions | undefined, includeSchema: boolean): OpenAI.ResponseFormatJSONSchema | undefined {
  if (!includeSchema || !opts?.responseSchema) return undefined;
  return {
    type: 'json_schema',
    json_schema: { name: opts.responseSchema.name, schema: opts.responseSchema.schema },
  };
}

// Ollama version in use is not pinned anywhere in this codebase -- structured
// output (response_format: json_schema) support can't be statically
// guaranteed. Rather than hard-failing a job over a backend that doesn't
// support it, degrade once to a schema-less retry on the specific
// status codes an unsupported/malformed response_format would produce.
function isSchemaRejection(err: unknown): boolean {
  return err instanceof OpenAI.APIError && (err.status === 400 || err.status === 422);
}

export interface OpenWebUiClientConfig {
  LLM_BASE_URL: string;
  LLM_API_KEY?: string;
  LLM_CHAT_MODEL: string;
  LLM_VISION_MODEL?: string;
  LLM_TRUSTED_LOCAL: boolean;
  EMBED_TRANSPORT: 'ollama' | 'openai';
  EMBED_BASE_URL?: string;
  EMBED_MODEL: string;
  EMBED_PATH: string;
  SHOW_PATH: string;
  FILES_UPLOAD_PATH: string;
  FILES_STATUS_PATH: string;
  LLM_REQUEST_TIMEOUT_MS: number;
}

@Injectable()
export class OpenWebUiClient implements LlmClient {
  private readonly openai: OpenAI;

  constructor(private readonly config: OpenWebUiClientConfig) {
    this.openai = new OpenAI({
      baseURL: config.LLM_BASE_URL,
      apiKey: config.LLM_API_KEY ?? 'unused',
      timeout: config.LLM_REQUEST_TIMEOUT_MS,
      // Root cause of job a830aa30's ~66min failure (confirmed): the SDK's
      // own default (maxRetries: 2) silently re-ran a whole >10min inference
      // up to 3 times on timeout before ever surfacing an error -- not a
      // missing retry, an actively harmful one. chat()/streamChat()/vision()
      // calls are non-idempotent, multi-minute, and NOT safe to blindly
      // re-run; a real failure should surface immediately so the caller's
      // own timeout ladder (ingestion's 30min, this orchestrator's 1h) can
      // report it while there's still margin left, instead of the SDK
      // silently eating that margin on retries of its own.
      maxRetries: 0,
    });
  }

  async chat(messages: ChatMessage[], opts?: LlmChatOptions): Promise<LlmChatResult> {
    const outboundMessages = this.config.LLM_TRUSTED_LOCAL ? messages : redactMessages(messages);
    // Ollama-specific extras, not part of the OpenAI spec -- its OpenAI-compat
    // endpoint accepts a passthrough `options` object for native Ollama
    // request options. Built as ONE merged object (not one independent
    // spread per field) since multiple `options:` spread entries in the same
    // object literal would silently OVERWRITE each other (later key wins),
    // losing whichever was set first. A genuine OpenAI-compat backend (the
    // production frontier-model proxy) simply ignores an unrecognized field.
    // See LlmChatOptions.numCtx/topK/minP doc comments.
    const ollamaOptions: Record<string, number> = {};
    if (opts?.numCtx !== undefined) ollamaOptions.num_ctx = opts.numCtx;
    if (opts?.topK !== undefined) ollamaOptions.top_k = opts.topK;
    if (opts?.minP !== undefined) ollamaOptions.min_p = opts.minP;
    const buildParams = (includeSchema: boolean) => ({
      model: opts?.model ?? this.config.LLM_CHAT_MODEL,
      messages: outboundMessages as OpenAI.Chat.ChatCompletionMessageParam[],
      ...(opts?.temperature !== undefined ? { temperature: opts.temperature } : {}),
      // See LlmChatOptions.seed's doc comment -- only sent when a caller
      // explicitly asks for pinned sampling, so every other caller's default
      // behavior is unchanged.
      ...(opts?.seed !== undefined ? { seed: opts.seed } : {}),
      ...(buildResponseFormat(opts, includeSchema) ? { response_format: buildResponseFormat(opts, includeSchema) } : {}),
      // Ollama maps OpenAI-compat max_tokens -> its own num_predict. Bounds
      // worst-case latency for a reasoning model's otherwise-unbounded
      // chain-of-thought + answer (see LlmChatOptions.maxTokens doc comment).
      ...(opts?.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
      ...(Object.keys(ollamaOptions).length > 0 ? { options: ollamaOptions } : {}),
      // `reasoning_effort: 'none'` -- NOT an Ollama-native `options.*` field
      // like numCtx/topK/minP above; it's Ollama's OpenAI-compat endpoint's
      // OWN top-level field for controlling reasoning (confirmed against
      // Ollama's own openai/openai.go: ChatCompletionRequest.ReasoningEffort,
      // mapped internally to api.ThinkValue -- a bare `think`/`options.think`
      // field is silently ignored by this endpoint, confirmed live: it
      // produced a real `reasoning` field in the response and no speedup).
      // The OpenAI SDK's own ReasoningEffort type is 'low'|'medium'|'high'|
      // null (real OpenAI o1/o3 models don't support 'none') -- 'none' is
      // an Ollama-specific extension of the same field, confirmed valid
      // server-side even though the SDK's TS union doesn't know about it;
      // cast past that narrower type rather than widen it repo-wide. Only
      // sent when explicitly `false`; omitted otherwise so every other
      // caller's default reasoning behavior is unaffected.
      ...(opts?.think === false ? { reasoning_effort: 'none' as OpenAI.ReasoningEffort } : {}),
      ...(opts?.tools !== undefined ? { tools: opts.tools as OpenAI.Chat.ChatCompletionTool[] } : {}),
      ...(opts?.toolChoice !== undefined ? { tool_choice: opts.toolChoice } : {}),
    });
    const toResult = (response: OpenAI.Chat.ChatCompletion): LlmChatResult => ({
      content: response.choices[0]?.message?.content ?? '',
      toolCalls: response.choices[0]?.message?.tool_calls as LlmChatResult['toolCalls'],
      finishReason: response.choices[0]?.finish_reason,
    });
    try {
      const response = await this.openai.chat.completions.create(buildParams(true));
      return toResult(response);
    } catch (err) {
      if (opts?.responseSchema && isSchemaRejection(err)) {
        const response = await this.openai.chat.completions.create(buildParams(false));
        return toResult(response);
      }
      throw err;
    }
  }

  async listModels(): Promise<string[]> {
    const page = await this.openai.models.list();
    return page.data.map((m) => m.id);
  }

  // Cheap reachability probe for the sidebar's connection-status LED --
  // deliberately a SHORT per-call timeout (unlike every other call in this
  // client, which relies on the SDK's own much longer default) so an
  // unreachable backend fails fast instead of leaving the UI's status dot
  // spinning for minutes. Reuses the lightest real call already available
  // (models.list) rather than adding a dedicated ping endpoint upstream.
  async checkHealth(): Promise<{ status: 'reachable' | 'unreachable'; latencyMs: number }> {
    const start = Date.now();
    try {
      await this.openai.models.list({ timeout: 5000 });
      return { status: 'reachable', latencyMs: Date.now() - start };
    } catch {
      return { status: 'unreachable', latencyMs: Date.now() - start };
    }
  }

  async *streamChat(messages: ChatMessage[], opts?: LlmChatOptions): AsyncGenerator<LlmStreamChunk> {
    const outboundMessages = this.config.LLM_TRUSTED_LOCAL ? messages : redactMessages(messages);
    // Same Ollama-passthrough-options construction as chat() above -- see
    // that method's own comment for why this must be ONE merged object.
    // Previously silently dropped here even though LlmChatOptions/the DTO
    // both accept them, and chat() already forwards them for the
    // non-streaming path.
    const ollamaOptions: Record<string, number> = {};
    if (opts?.numCtx !== undefined) ollamaOptions.num_ctx = opts.numCtx;
    if (opts?.topK !== undefined) ollamaOptions.top_k = opts.topK;
    if (opts?.minP !== undefined) ollamaOptions.min_p = opts.minP;
    const buildParams = (includeSchema: boolean) => ({
      model: opts?.model ?? this.config.LLM_CHAT_MODEL,
      messages: outboundMessages as OpenAI.Chat.ChatCompletionMessageParam[],
      stream: true as const,
      ...(opts?.temperature !== undefined ? { temperature: opts.temperature } : {}),
      // See chat()'s own seed comment -- only sent when a caller explicitly
      // asks for pinned sampling.
      ...(opts?.seed !== undefined ? { seed: opts.seed } : {}),
      ...(buildResponseFormat(opts, includeSchema) ? { response_format: buildResponseFormat(opts, includeSchema) } : {}),
      ...(opts?.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
      ...(Object.keys(ollamaOptions).length > 0 ? { options: ollamaOptions } : {}),
      // See chat()'s own reasoning_effort comment for why this is the
      // correct field for Ollama's OpenAI-compat endpoint (not a bare
      // think/options.think field). Only sent when explicitly `false`.
      ...(opts?.think === false ? { reasoning_effort: 'none' as OpenAI.ReasoningEffort } : {}),
    });
    let stream;
    try {
      stream = await this.openai.chat.completions.create(buildParams(true));
    } catch (err) {
      if (opts?.responseSchema && isSchemaRejection(err)) {
        stream = await this.openai.chat.completions.create(buildParams(false));
      } else {
        throw err;
      }
    }
    // `reasoning` is Ollama's OpenAI-compat streaming delta field for a
    // reasoning model's chain-of-thought (the streaming counterpart of the
    // non-stream response's `message.reasoning`, confirmed live above) --
    // not part of the OpenAI SDK's own delta type, hence the inline shape.
    for await (const chunk of stream as AsyncIterable<{ choices: { delta?: { content?: string; reasoning?: string } }[] }>) {
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;
      if (delta.content || delta.reasoning) {
        yield { ...(delta.content ? { content: delta.content } : {}), ...(delta.reasoning ? { reasoning: delta.reasoning } : {}) };
      }
    }
  }

  async embed(texts: string[], opts?: { model?: string }): Promise<number[][]> {
    if (this.config.EMBED_TRANSPORT !== 'ollama') {
      throw new Error(
        `OpenWebUiClient.embed() not implemented for EMBED_TRANSPORT=${this.config.EMBED_TRANSPORT} — only 'ollama' (the confirmed-real Open WebUI/Ollama transport) is implemented`,
      );
    }
    const outboundTexts = this.config.LLM_TRUSTED_LOCAL ? texts : texts.map(redactText);
    const baseUrl = (this.config.EMBED_BASE_URL ?? this.config.LLM_BASE_URL).replace(/\/v1\/?$/, '');
    // Retried (unlike chat()/vision()) -- a pure read with no side effects,
    // safe to re-run on a transient 429/5xx/network failure. See
    // retryWithBackoff.ts's own doc comment for why this is the opposite
    // call of the OpenAI client's maxRetries:0 above. maxRetries:3 (not the
    // helper's own default of 5) -- this call sits synchronously in an
    // already-slow SURVEY pipeline path; 3 attempts with exponential
    // backoff is enough margin for a transient blip without piling on
    // multiple extra seconds of dead time on a persistent failure.
    const response = await fetchWithRetry(
      () =>
        fetch(`${baseUrl}${this.config.EMBED_PATH}`, {
          method: 'POST',
          headers: this.nativeOllamaHeaders(),
          body: JSON.stringify({ model: opts?.model ?? this.config.EMBED_MODEL, input: outboundTexts }),
        }),
      { maxRetries: 3 },
    );
    if (!response.ok) {
      throw new Error(`Ollama embed request failed: ${response.status}`);
    }
    const body = (await response.json()) as { embeddings: number[][] };
    return body.embeddings;
  }

  // Shared by embed()/showModel() -- both bypass the OpenAI SDK client
  // (this.openai, used by chat()/vision()/listModels(), already
  // constructed with apiKey: LLM_API_KEY) since they hit Ollama's/Open
  // WebUI's NATIVE API shape, not its OpenAI-compat surface. Confirmed
  // live: a real Open WebUI instance (unlike raw Ollama, which needs no
  // auth at all) 401s on either endpoint with no Authorization header --
  // a real gap, silently invisible until this codebase's dev target
  // actually became Open WebUI instead of bare Ollama.
  private nativeOllamaHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      ...(this.config.LLM_API_KEY ? { Authorization: `Bearer ${this.config.LLM_API_KEY}` } : {}),
    };
  }

  // Real gap this closes: ingestion's _resolve_caps (llm_leveling.py) is a
  // hand-maintained table of per-model context length/coverage-budget/
  // tool-support, populated by a human manually running Ollama's real
  // /api/show endpoint once per model and hardcoding the result -- any
  // model NOT in that table gets the same blanket conservative guess
  // regardless of what it actually is. /api/show is Ollama's NATIVE API
  // (not its OpenAI-compat surface), same reason embed() above needs the
  // same base-URL stripping. contextLength is read from
  // model_info[f"{architecture}.context_length"] -- the architecture-
  // prefixed key name Ollama actually uses (confirmed against real /api/show
  // output; there is no unprefixed "context_length" field). null when
  // either key is missing (an unrecognized architecture, or a backend that
  // returns a shape this doesn't expect) -- never throws on a merely-absent
  // field, only on a genuinely unreachable/non-Ollama backend (a real
  // OpenAI-compat frontier proxy has no /api/show at all).
  // Open WebUI virtual multi-model constructs (e.g. "Arena Model") have no
  // corresponding real Ollama model and no /api/show entry at all -- a bare
  // showModel() call against one would fail with an opaque, easy-to-misread
  // HTTP error (looks identical to "backend unreachable"). Named + growable
  // if Open WebUI adds more virtual model kinds later; not a general
  // capability check, just this one confirmed real gap.
  private static readonly VIRTUAL_MODEL_NAMES = new Set(['Arena Model']);

  async showModel(model: string): Promise<{ contextLength: number | null; capabilities: string[] }> {
    if (OpenWebUiClient.VIRTUAL_MODEL_NAMES.has(model)) {
      throw new Error(
        `showModel() called with "${model}" -- an Open WebUI virtual multi-model construct, not a real Ollama model with its own /api/show entry. Caller should fall back to conservative capability defaults, same as any unreachable/unrecognized model.`,
      );
    }
    const baseUrl = (this.config.EMBED_BASE_URL ?? this.config.LLM_BASE_URL).replace(/\/v1\/?$/, '');
    // Retried -- same reasoning as embed() above (pure read, safe to re-run,
    // maxRetries:3 to bound worst-case dead time on a persistent failure).
    const response = await fetchWithRetry(
      () =>
        fetch(`${baseUrl}${this.config.SHOW_PATH}`, {
          method: 'POST',
          headers: this.nativeOllamaHeaders(),
          body: JSON.stringify({ model }),
        }),
      { maxRetries: 3 },
    );
    if (!response.ok) {
      throw new Error(`Ollama /api/show request failed: ${response.status}`);
    }
    const body = (await response.json()) as {
      capabilities?: string[];
      model_info?: Record<string, unknown>;
    };
    const modelInfo = body.model_info ?? {};
    const architecture = modelInfo['general.architecture'];
    const contextLengthRaw = typeof architecture === 'string' ? modelInfo[`${architecture}.context_length`] : undefined;
    const contextLength = typeof contextLengthRaw === 'number' ? contextLengthRaw : null;
    return { contextLength, capabilities: body.capabilities ?? [] };
  }

  async vision(
    prompt: string,
    images: Buffer[],
    opts?: { model?: string; mimeType?: string; responseSchema?: LlmResponseSchema },
  ): Promise<string> {
    const model = opts?.model ?? this.config.LLM_VISION_MODEL;
    if (!model) {
      throw new Error('vision() called with no model available -- set LLM_VISION_MODEL or pass opts.model');
    }
    // Same OpenAI-compatible chat.completions endpoint as chat(), just with
    // a multimodal content array -- Ollama/Open WebUI's OpenAI-compat API
    // accepts image_url content parts for vision-capable models (llava,
    // bakllava, moondream, etc.) the same way OpenAI's own API does.
    // mimeType defaults to image/png -- the pre-existing hardcoded value,
    // harmless for docx-embedded figures whose real type was never
    // surfaced, but now correctly overridable for directly-uploaded
    // non-PNG images (KB image ingestion).
    const mimeType = opts?.mimeType ?? 'image/png';
    const outboundPrompt = this.config.LLM_TRUSTED_LOCAL ? prompt : redactText(prompt);
    const content: OpenAI.Chat.ChatCompletionContentPart[] = [
      { type: 'text', text: outboundPrompt },
      ...images.map((image) => ({
        type: 'image_url' as const,
        image_url: { url: `data:${mimeType};base64,${image.toString('base64')}` },
      })),
    ];
    const buildParams = (includeSchema: boolean) => ({
      model,
      messages: [{ role: 'user' as const, content }],
      // Confirmed real root cause of run-to-run SURVEY node-count variance
      // (74 vs ~120 nodes for the identical document): unlike every other
      // call in this module, this one previously set neither temperature
      // nor seed, so each figure's caption was freshly (re-)sampled on
      // every job -- and caption text feeds directly into
      // llm_leveling.py's token-budget branch splitter, so a differently
      // worded caption can shift branch boundaries and, with them, total
      // node count. A caption is structured extraction (describe what's in
      // the image), not creative writing -- temperature 0 is the correct
      // setting on its own merits, seed is defensive/hygiene on top of
      // that in case this backend ever runs at a non-zero temperature.
      temperature: 0,
      seed: 0,
      // No output cap previously existed here at all -- the prompt asks
      // for "one or two sentences" (orchestrator_vision_client.py's
      // _build_prompt), so a real caption is SUPPOSED to be short, but
      // nothing bounded the worst case (a reasoning-capable vision model
      // going off the rails on a pathological image). Bounds latency risk
      // only; the byte-hash cache (main.py's figure-caption memoization)
      // already removes the repeat cost of a slow caption on re-runs.
      //
      // Second live incident (confirmed via a real SURVEY run's figure
      // descriptions): the deployed vision model, for a genuinely complex
      // multi-view engineering drawing, ignored the prior soft "one or two
      // sentences" wording and produced a markdown breakdown per view (a
      // header + several full sentences each), long enough to get cut off
      // mid-JSON by this 200-token cap -- orchestrator_vision_client.py's
      // repair_json fallback then "repairs" the truncated JSON into
      // schema-valid (parseable, significant=True) but content-truncated
      // output, worse than the reasoning-exhaustion incident below (empty
      // content) because it looks like a normal, complete caption instead
      // of failing loudly. The real fix is enforcing brevity at the
      // source (the prompt + schema field description in
      // orchestrator_vision_client.py now spell it out explicitly and
      // structurally, not just as a soft ask) -- raising this cap to
      // chase an unbounded worst case would only make a genuinely
      // non-compliant response MORE expensive per call, not prevent it.
      // 300 is a defensive backstop a few times wider than a real
      // one-or-two-sentence caption ever needs, not the primary defense.
      max_tokens: 300,
      // Real, 100%-reproducible root cause (confirmed live: every single
      // figure in a real document came back "no useful caption returned"
      // on a genuinely fresh, uncached run): unlike chat()'s own
      // `opts?.think === false` handling above, this call never disabled
      // reasoning at all. gemma4:e4b (this deployment's configured vision
      // model) reports a real "thinking" capability -- its chain-of-thought
      // tokens consumed the entire max_tokens budget before any real answer
      // token was ever produced, leaving message.content genuinely empty
      // (the reasoning itself lands in the separate message.reasoning
      // field, never read here). A one-line image caption has no
      // legitimate use for a reasoning trace -- same "structured
      // extraction, not creative writing" reasoning the temperature=0
      // comment above already states, applied to the token-budget problem
      // reasoning caused. Same `reasoning_effort: 'none'` knob chat() uses,
      // just unconditional here since no caller ever wants a captioned
      // reasoning trace.
      reasoning_effort: 'none' as OpenAI.ReasoningEffort,
      // Third live incident, confirmed via a real completed job's actual
      // figure descriptions (not a synthetic test): 2 of 42 real captions
      // came back with the SAME content repeated near-verbatim within one
      // response, trailed by a stray, broken continuation fragment
      // ("```json {") -- confirmed this is genuinely inside the JSON
      // string's own content, not a parsing bug on ingestion's side (the
      // JSON envelope itself is syntactically valid; response_format's
      // schema enforcement constrains STRUCTURE, not content quality, so
      // it cannot prevent a model from writing degenerate/looping text
      // inside a valid string field). A schema-constrained, structured-
      // extraction call like this one has no legitimate use for repeating
      // itself -- frequency_penalty is the standard OpenAI-compatible
      // decoding knob for discouraging exact-phrase repetition, same
      // "structured extraction, not creative writing" reasoning
      // temperature=0 above already applies, now to the repetition-loop
      // problem specifically. A mitigation, not a guarantee -- repetition-
      // loop behavior is probabilistic, not a deterministic bug this
      // parameter can promise to eliminate.
      frequency_penalty: 0.4,
      ...(buildResponseFormat(opts, includeSchema) ? { response_format: buildResponseFormat(opts, includeSchema) } : {}),
    });
    try {
      const response = await this.openai.chat.completions.create(buildParams(true));
      return response.choices[0]?.message?.content ?? '';
    } catch (err) {
      if (opts?.responseSchema && isSchemaRejection(err)) {
        const response = await this.openai.chat.completions.create(buildParams(false));
        return response.choices[0]?.message?.content ?? '';
      }
      throw err;
    }
  }

  // Derives Open WebUI's true app root from LLM_BASE_URL for its NATIVE
  // (non-OpenAI-compat) file API -- uploadFile/pollFileProcessed/deleteFile
  // all need this, unlike chat()/embed(), which correctly go through
  // whichever OpenAI-compat surface LLM_BASE_URL points at. The native file
  // API (/api/v1/files/...) lives ONLY at the app root and is never mirrored
  // under any OpenAI-compat proxy prefix. Confirmed live: with
  // LLM_BASE_URL=http://host:3000/ollama/v1 (a real dev config, where Open
  // WebUI's Ollama integration is genuinely connected), the old bare
  // `.replace(/\/v1\/?$/, '')` left `/ollama` in place, producing
  // http://host:3000/ollama/api/v1/files/ -- a real route that exists but
  // rejects POST (405), not the files endpoint at all (the true endpoint,
  // http://host:3000/api/v1/files/, returned 401 unauthenticated -- i.e.
  // genuinely reachable). The primer's fail-open design meant this never
  // surfaced as a job failure, only as "the primer silently never works,"
  // confirmed via docker logs during a real SURVEY run.
  //
  // Strips an optional `ollama/` OR `api/` segment immediately before the
  // trailing `v1` so `.../v1`, `.../ollama/v1`, and `.../api/v1` all
  // resolve to the same true app root. The `api/` case matters because
  // `.../ollama/v1` is only a legitimate LLM_BASE_URL value when the target
  // instance's Ollama integration is actually enabled -- confirmed on a
  // real production instance where it is disabled at the platform level,
  // making `.../ollama/v1` a dead endpoint there (empty model list, chat
  // 503/disabled) while `.../api/v1` (Open WebUI's own first-class
  // OpenAI-compatible REST namespace) works reliably. Which value is
  // correct is a per-deployment fact, not a universal one -- this method
  // must derive the right app root for either.
  private openWebUiAppRoot(): string {
    return this.config.LLM_BASE_URL.replace(/\/(ollama\/|api\/)?v1\/?$/, '');
  }

  // The whole-document AI context primer (Phase 6c, pipeline.worker.ts)
  // needs Open WebUI's NATIVE full-document file-context mode -- chat()
  // cannot reach it. chat() goes through the OpenAI SDK, whose
  // chat.completions.create() always POSTs to {baseURL}/chat/completions;
  // with LLM_BASE_URL routed through Open WebUI's Ollama-compatibility
  // proxy (.../ollama/v1, this deployment's real config), that lands on
  // the Ollama-compat proxy route, a genuinely different backend code
  // path that never runs the file-context middleware at all. Confirmed
  // against Open WebUI v0.8.12 source
  // (backend/open_webui/utils/middleware.py's process_chat_payload and
  // chat_completion_files_handler, and retrieval/utils.py's
  // get_sources_from_items): only the NATIVE route (POST
  // /api/chat/completions) parses the top-level `files` array's
  // per-item `context: "full"` flag and, when set, returns the file's
  // full stored content instead of routing it into chunked RAG. This is
  // a genuine per-request field any authenticated user's API key can
  // set -- confirmed with a canary phrase embedded in a real uploaded
  // file, returned correctly ONLY via this native-endpoint +
  // `context: "full"` combination (the SDK path silently never saw the
  // file at all -- "I cannot see an attached document..." -- despite
  // accepting the old chat()-forwarded `files` field with no error,
  // which is why that field is retired rather than fixed in place: it
  // was never reachable through the right endpoint to begin with).
  //
  // Deliberately narrow (unlike chat()'s general-purpose surface) --
  // this method exists for exactly one caller with exactly one shape:
  // a single user-turn prompt against one already-uploaded, already-
  // processed file. temperature/seed are hardcoded to 0, matching the
  // primer's own existing determinism requirement (this text feeds both
  // every branch's analyze_section prompt AND the figure-caption cache
  // key -- see pipeline.worker.ts's own PRIMER_FIXED_NUM_CTX comment).
  async chatWithFullFileContext(
    content: string,
    fileId: string,
    opts: { maxTokens?: number; numCtx?: number },
  ): Promise<LlmChatResult> {
    const outboundContent = this.config.LLM_TRUSTED_LOCAL ? content : redactText(content);
    const response = await fetch(`${this.openWebUiAppRoot()}/api/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.config.LLM_API_KEY ? { Authorization: `Bearer ${this.config.LLM_API_KEY}` } : {}),
      },
      body: JSON.stringify({
        model: this.config.LLM_CHAT_MODEL,
        messages: [{ role: 'user', content: outboundContent }],
        files: [{ type: 'file', id: fileId, context: 'full' }],
        temperature: 0,
        seed: 0,
        ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
        ...(opts.numCtx !== undefined ? { options: { num_ctx: opts.numCtx } } : {}),
      }),
    });
    if (!response.ok) {
      throw new Error(`OpenWebUiClient.chatWithFullFileContext failed: ${response.status}`);
    }
    const data = (await response.json()) as { choices?: { message?: { content?: string } }[] };
    return { content: data.choices?.[0]?.message?.content ?? '' };
  }

  // Uploads a source document to Open WebUI's native file API (not the
  // OpenAI-compat surface -- same reason embed()/showModel() bypass
  // this.openai) so a later call can generate the whole-document AI context
  // primer (Phase 6) from it. FormData/Blob are global in Node 18+, no
  // import needed.
  async uploadFile(buffer: Buffer, filename: string): Promise<string> {
    const baseUrl = this.openWebUiAppRoot();
    const form = new FormData();
    form.append('file', new Blob([buffer]), filename);
    // ?process=true -- confirmed via the real Open WebUI browser UI's own
    // Network tab (attaching a file calls exactly this URL shape). Without
    // it the file uploads but is never run through Open WebUI's
    // text-extraction/chunking pipeline, matching a known upstream report
    // (open-webui/open-webui#13600: upload succeeds, data.content stays
    // empty) -- pollFileProcessed() below would then poll a file that was
    // never queued for processing in the first place.
    const response = await fetch(`${baseUrl}${this.config.FILES_UPLOAD_PATH}?process=true`, {
      method: 'POST',
      // No Content-Type header here -- fetch sets the correct
      // multipart/form-data boundary itself when given a FormData body;
      // nativeOllamaHeaders() hardcodes application/json, which would
      // break the multipart upload.
      headers: this.config.LLM_API_KEY ? { Authorization: `Bearer ${this.config.LLM_API_KEY}` } : {},
      body: form,
    });
    if (!response.ok) {
      throw new Error(`OpenWebUiClient.uploadFile failed: ${response.status}`);
    }
    const data = (await response.json()) as { id: string };
    return data.id;
  }

  // Polls Open WebUI's file-processing-status endpoint until the uploaded
  // file reaches a terminal state, or timeoutMs elapses. Never throws --
  // a transient poll failure is not itself a verdict, so it's swallowed and
  // polling continues until the deadline; a stuck 'pending' and a timeout
  // both resolve false the same way, matching "primer generation didn't
  // work out, proceed without it" being the only two real outcomes callers
  // need to distinguish (succeeded vs. didn't).
  async pollFileProcessed(fileId: string, timeoutMs: number): Promise<boolean> {
    const baseUrl = this.openWebUiAppRoot();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`${baseUrl}${this.config.FILES_STATUS_PATH}/${fileId}/process/status`, {
          headers: this.nativeOllamaHeaders(),
        });
        if (response.ok) {
          const data = (await response.json()) as { status?: string };
          if (data.status === 'completed') return true;
          if (data.status === 'failed') return false;
        }
      } catch {
        // A transient poll failure is not itself a verdict -- keep polling
        // until the deadline, then time out the same as a stuck 'pending'.
      }
      // Clamped to the remaining budget -- without this, a poll interval
      // longer than what's left before the deadline (the common case for a
      // short timeoutMs, and the tail iteration of any timeoutMs) silently
      // rounds the actual wait up to a full extra 1000ms past the caller's
      // requested deadline.
      await new Promise((resolve) => setTimeout(resolve, Math.min(1000, deadline - Date.now())));
    }
    return false;
  }

  // Best-effort cleanup of an uploaded file once the primer has already
  // resolved (succeeded or not) -- a delete failure must never mask that
  // already-resolved result or throw past the caller, so this swallows its
  // own errors entirely rather than surfacing them.
  async deleteFile(fileId: string): Promise<void> {
    const baseUrl = this.openWebUiAppRoot();
    try {
      await fetch(`${baseUrl}${this.config.FILES_STATUS_PATH}/${fileId}`, {
        method: 'DELETE',
        headers: this.nativeOllamaHeaders(),
      });
    } catch {
      // Best-effort cleanup -- a delete failure must never mask the
      // primer's already-resolved result or throw past the caller.
    }
  }
}
