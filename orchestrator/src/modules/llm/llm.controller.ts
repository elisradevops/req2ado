import { BadRequestException, Body, Controller, Get, Headers, HttpException, Logger, NotFoundException, Optional, Post, Res, UnauthorizedException, UseGuards } from '@nestjs/common';
import OpenAI from 'openai';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { llmChatRequestSchema, type LlmChatRequestBody } from './llm-chat.dto';
import { llmEmbedRequestSchema } from './llm-embed.dto';
import { llmShowRequestSchema } from './llm-show.dto';
import { llmVisionRequestSchema } from './llm-vision.dto';
import type { LlmRouting, LlmToolCall, LlmUsage } from './llm-client.interface';
import { TokenUsageRecorder } from './token-usage';
import type { ChatMessage } from './redactor';
import { LlmProxyBearerGuard } from './llm-proxy-bearer.guard';
import { OpenWebUiClientFactory } from './openwebui-client.factory';
import { ModelInfoUnavailableError, UpstreamHttpError, type ModelInfo } from './openwebui.client';
import { Public } from '../auth/public.decorator';

/** The request's messages as the LLM client takes them: content sent as text parts becomes the joined text, with the parts (and which
 * one ends a stable prefix) kept beside it for the prompt-cache breakpoint. */
function chatMessages(messages: LlmChatRequestBody['messages']): ChatMessage[] {
  return messages.map((message) => {
    if (!Array.isArray(message.content)) return message as ChatMessage;
    const parts = message.content.map((part) => ({ text: part.text, ...(part.cache_control ? { cache: true } : {}) }));
    return { ...message, content: parts.map((part) => part.text).join(''), parts } as ChatMessage;
  });
}

// Every route here is internal service-to-service traffic already gated by
// LlmProxyBearerGuard (ingestion's shared bearer token), not public traffic
// -- the global ThrottlerGuard (app.module.ts, 200 req/60s) was never meant
// to rate-limit it. The agentic SURVEY redesign's query_kb tool-calling loop
// (see ingestion/app/survey/orchestrator_llm_client.py) can fire several
// /llm/embed calls per branch, making throttle pressure here newly likely,
// not just theoretical.
// @Public(): this is bearer-guarded service-to-service traffic (ingestion
// calling in), not a browser session -- the global session AuthGuard
// (app.module.ts) must not also demand a cookie here.
@SkipThrottle()
@Public()
@Controller('llm')
@UseGuards(LlmProxyBearerGuard)
export class LlmController {
  private readonly logger = new Logger(LlmController.name);

  constructor(
    private readonly clientFactory: OpenWebUiClientFactory,
    // Optional so a controller built without a ledger (older tests) still serves calls; nothing is recorded then.
    @Optional() private readonly tokenUsage?: TokenUsageRecorder,
  ) {}

  // The X-Req2Ado-User-Id header carries the submitting user's identity on
  // every ingestion-originated call -- ingestion already receives job.userId
  // (see ingestionClient.level()'s own call site in pipeline.worker.ts) and
  // forwards it here so each job's LLM traffic resolves to that user's own
  // Open WebUI token/model, not a shared global one (removed, see B7).
  // Rejected outright when absent or unknown, rather than falling back to
  // any shared default -- that fallback is exactly the bug per-user
  // credentials exist to close.
  private async resolveClient(userId: string | undefined) {
    if (!userId) {
      throw new UnauthorizedException('X-Req2Ado-User-Id header is required');
    }
    try {
      return await this.clientFactory.getClientFor(userId);
    } catch {
      throw new UnauthorizedException(`No Open WebUI connection configured for user ${userId}`);
    }
  }

  /**
   * When the caller closes its connection before an answer was sent (a cancelled job, a timed-out request), stop the upstream call
   * too: otherwise a backend that serves one request at a time keeps working for nobody and the next call queues behind it.
   */
  private abortOnClose(res: Response | undefined, what: 'chat' | 'vision'): AbortSignal | undefined {
    if (!res) return undefined;
    const controller = new AbortController();
    const startedAt = Date.now();
    res.on('close', () => {
      if (!res.writableEnded) {
        this.logger.warn(`${what} call aborted: the caller closed the connection after ${Date.now() - startedAt} ms; the upstream request is cancelled`);
        controller.abort();
      }
    });
    return controller.signal;
  }

  @Post('chat')
  async chat(
    @Body() rawBody: unknown,
    @Headers('x-req2ado-user-id') userId: string | undefined,
    @Res({ passthrough: true }) res?: Response,
    // Which job and pipeline stage this call is for, set by the ingestion service; absent on any other caller. Used only for the token ledger.
    @Headers('x-req2ado-job-id') jobId?: string,
    @Headers('x-req2ado-stage') stage?: string,
  ): Promise<{ content: string; toolCalls?: LlmToolCall[]; finishReason?: string; usage?: LlmUsage; routing?: LlmRouting }> {
    const parseResult = llmChatRequestSchema.safeParse(rawBody);
    if (!parseResult.success) {
      throw new BadRequestException('Invalid request body: messages must be a non-empty array');
    }
    const body = parseResult.data;
    const signal = this.abortOnClose(res, 'chat');
    const llmClient = await this.resolveClient(userId);
    try {
      const result = await llmClient.chat(chatMessages(body.messages), {
        ...(body.promptCache !== undefined ? { promptCache: body.promptCache } : {}),
        ...(signal ? { signal } : {}),
        ...(body.model !== undefined ? { model: body.model } : {}),
        ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
        ...(body.seed !== undefined ? { seed: body.seed } : {}),
        ...(body.responseSchema !== undefined ? { responseSchema: body.responseSchema } : {}),
        ...(body.maxTokens !== undefined ? { maxTokens: body.maxTokens } : {}),
        ...(body.numCtx !== undefined ? { numCtx: body.numCtx } : {}),
        ...(body.topK !== undefined ? { topK: body.topK } : {}),
        ...(body.minP !== undefined ? { minP: body.minP } : {}),
        ...(body.tools !== undefined ? { tools: body.tools } : {}),
        ...(body.toolChoice !== undefined ? { toolChoice: body.toolChoice } : {}),
        ...(body.think !== undefined ? { think: body.think } : {}),
        ...(body.budgetKind !== undefined ? { budgetKind: body.budgetKind } : {}),
        ...(body.fileId !== undefined ? { fileId: body.fileId } : {}),
        ...(body.deadlineMs !== undefined ? { deadlineAtMs: Date.now() + body.deadlineMs } : {}),
      });
      if (jobId && this.tokenUsage) {
        // Under a router (the gateway's `Auto`) the tokens were spent by the model it sent the call to, when the answer named it.
        await this.tokenUsage.record({ jobId, stage: stage?.trim() || 'other', model: result.routing?.model ?? body.model ?? llmClient.chatModel, ...(result.usage ? { usage: result.usage } : {}) });
      }
      return result;
    } catch (err) {
      if (err instanceof UpstreamHttpError) throw new HttpException(err.message, err.upstreamStatus);
      throw err;
    }
  }

  @Post('chat/stream')
  async chatStream(
    @Body() rawBody: unknown,
    @Res() res: Response,
    @Headers('x-req2ado-user-id') userId: string | undefined,
    // As chat(): which job and stage the call is for, so a streamed call reaches the token ledger too.
    @Headers('x-req2ado-job-id') jobId?: string,
    @Headers('x-req2ado-stage') stage?: string,
  ): Promise<void> {
    const parseResult = llmChatRequestSchema.safeParse(rawBody);
    if (!parseResult.success) {
      throw new BadRequestException('Invalid request body: messages must be a non-empty array');
    }
    const body = parseResult.data;
    const llmClient = await this.resolveClient(userId);
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Transfer-Encoding', 'chunked');
    // "Stop generating" support: when the downstream caller (ingestion)
    // aborts and closes its httpx connection to this endpoint, Express fires
    // 'close' on the response. Without this, the loop below kept iterating
    // this.llmClient.streamChat() to completion regardless, so the upstream
    // Ollama/Open WebUI generation kept running and burning compute after
    // nobody was reading the tokens. Checking the flag right after each
    // write stops consuming/writing further chunks as soon as the current
    // await resolves — the best granularity available without deeper
    // OpenAI SDK abort-signal plumbing (out of scope here), since it can't
    // instantly abort a stream mid-network-call.
    let clientDisconnected = false;
    // A caller that goes away also aborts the upstream request (as chat() does), so the model stops generating at once instead of
    // after the next chunk arrives.
    const upstream = new AbortController();
    res.on('close', () => {
      clientDisconnected = true;
      if (!res.writableEnded) upstream.abort();
    });
    let wrote = false;
    let usage: LlmUsage | undefined;
    let finishReason: string | undefined;
    let routing: LlmRouting | undefined;
    let completed = false;
    try {
      for await (const chunk of llmClient.streamChat(chatMessages(body.messages), {
        ...(body.promptCache !== undefined ? { promptCache: body.promptCache } : {}),
        ...(body.model !== undefined ? { model: body.model } : {}),
        ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
        ...(body.seed !== undefined ? { seed: body.seed } : {}),
        ...(body.responseSchema !== undefined ? { responseSchema: body.responseSchema } : {}),
        ...(body.maxTokens !== undefined ? { maxTokens: body.maxTokens } : {}),
        // The DTO has accepted these since chat()'s own non-streaming path
        // started using them -- streamChat() silently discarded them until
        // now even though openwebui.client.ts's streamChat() forwards them
        // like chat() already does.
        ...(body.numCtx !== undefined ? { numCtx: body.numCtx } : {}),
        ...(body.topK !== undefined ? { topK: body.topK } : {}),
        ...(body.minP !== undefined ? { minP: body.minP } : {}),
        ...(body.think !== undefined ? { think: body.think } : {}),
        ...(body.budgetKind !== undefined ? { budgetKind: body.budgetKind } : {}),
        ...(body.deadlineMs !== undefined ? { deadlineAtMs: Date.now() + body.deadlineMs } : {}),
        signal: upstream.signal,
      })) {
        if (chunk.finishReason || chunk.routing || chunk.usage) {
          finishReason = chunk.finishReason ?? finishReason;
          routing = chunk.routing ?? routing;
          usage = chunk.usage ?? usage;
          if (!chunk.content && !chunk.reasoning) continue;
        }
        // `delta` stays the wire name for final-answer content (backward
        // compatible with every existing consumer); `reasoningDelta` is new,
        // additive, and only present on a reasoning-model chunk.
        res.write(`${JSON.stringify({ ...(chunk.content ? { delta: chunk.content } : {}), ...(chunk.reasoning ? { reasoningDelta: chunk.reasoning } : {}) })}\n`);
        wrote = true;
        if (clientDisconnected) break;
      }
      completed = !clientDisconnected;
      // Only written when the stream really ran to its end: a missing terminal
      // line is how the caller knows the answer may be cut off.
      if (completed && body.includeDone) {
        res.write(`${JSON.stringify({ done: true, ...(finishReason ? { finishReason } : {}), ...(body.model !== undefined ? { model: body.model } : {}), ...(routing ? { routing } : {}) })}\n`);
      }
      if (completed && jobId && this.tokenUsage) {
        // Same ledger entry chat() records; under a router, the tokens go to the model the stream named.
        await this.tokenUsage.record({ jobId, stage: stage?.trim() || 'other', model: routing?.model ?? body.model ?? llmClient.chatModel, ...(usage ? { usage } : {}) });
      }
    } catch (err) {
      // Before any output the status line is still free: an upstream HTTP error keeps its status (a content filter 422, a budget
      // 402, a rate limit 429 with its Retry-After), as chat() answers it. After output it can only end the stream without its
      // terminal line, which is how the caller knows the answer is incomplete.
      if (!wrote && err instanceof UpstreamHttpError) {
        res.status(err.upstreamStatus);
        res.write(JSON.stringify({ message: err.message }));
        return;
      }
      if (!wrote && err instanceof OpenAI.APIError && typeof err.status === 'number' && err.status >= 400 && err.status <= 599) {
        const retryAfter = err.headers?.['retry-after'];
        if (err.status === 429 && retryAfter) res.setHeader('Retry-After', String(retryAfter));
        res.status(err.status);
        res.write(JSON.stringify({ message: err.message }));
        return;
      }
      throw err;
    } finally {
      res.end();
    }
  }

  @Get('models')
  async models(@Headers('x-req2ado-user-id') userId: string | undefined): Promise<{ models: string[] }> {
    const llmClient = await this.resolveClient(userId);
    const models = await llmClient.listModels();
    return { models };
  }

  @Post('embed')
  async embed(
    @Body() rawBody: unknown,
    @Headers('x-req2ado-user-id') userId: string | undefined,
  ): Promise<{ embeddings: number[][] }> {
    const parseResult = llmEmbedRequestSchema.safeParse(rawBody);
    if (!parseResult.success) {
      throw new BadRequestException('Invalid request body: texts must be a non-empty array of strings');
    }
    const llmClient = await this.resolveClient(userId);
    try {
      const embeddings = await llmClient.embed(parseResult.data.texts);
      return { embeddings };
    } catch (err) {
      if (err instanceof UpstreamHttpError) throw new HttpException(err.message, err.upstreamStatus);
      throw err;
    }
  }

  // Backs ingestion's optional live per-model capability lookup
  // (_resolve_caps's caps_client param, llm_leveling.py) -- replaces a
  // blind conservative guess for any model NOT in that module's hand-
  // maintained table with a real measurement of THIS model's actual
  // context length/capabilities.
  @Post('show')
  async show(
    @Body() rawBody: unknown,
    @Headers('x-req2ado-user-id') userId: string | undefined,
  ): Promise<ModelInfo> {
    const parseResult = llmShowRequestSchema.safeParse(rawBody);
    if (!parseResult.success) {
      throw new BadRequestException('Invalid request body: model must be a non-empty string');
    }
    const llmClient = await this.resolveClient(userId);
    try {
      return await llmClient.showModel(parseResult.data.model);
    } catch (err) {
      // A model nothing can describe is an expected answer (ingestion then sizes it from its own rules), not a
      // server fault.
      if (err instanceof ModelInfoUnavailableError) throw new NotFoundException(err.message);
      throw err;
    }
  }

  @Post('vision')
  async vision(
    @Body() rawBody: unknown,
    @Headers('x-req2ado-user-id') userId: string | undefined,
    // How long the caller is willing to wait for this call, retries included (ms). Ingestion sends it so a slow model
    // is not retried past the figure's budget.
    @Headers('x-req2ado-deadline-ms') deadlineMsHeader?: string,
    @Res({ passthrough: true }) res?: Response,
  ): Promise<{ description: string }> {
    const parseResult = llmVisionRequestSchema.safeParse(rawBody);
    if (!parseResult.success) {
      throw new BadRequestException('Invalid request body: prompt and a non-empty images array (base64) are required');
    }
    const body = parseResult.data;
    const deadlineMs = Number(deadlineMsHeader);
    const deadlineAtMs = deadlineMsHeader && Number.isFinite(deadlineMs) && deadlineMs > 0 ? Date.now() + deadlineMs : undefined;
    const signal = this.abortOnClose(res, 'vision');
    const opts =
      body.model !== undefined || body.mimeType !== undefined || body.responseSchema !== undefined || signal || deadlineAtMs !== undefined
        ? {
            ...(body.model !== undefined ? { model: body.model } : {}),
            ...(body.mimeType !== undefined ? { mimeType: body.mimeType } : {}),
            ...(body.responseSchema !== undefined ? { responseSchema: body.responseSchema } : {}),
            ...(signal ? { signal } : {}),
            ...(deadlineAtMs !== undefined ? { deadlineAtMs } : {}),
          }
        : undefined;
    const llmClient = await this.resolveClient(userId);
    try {
      const description = await llmClient.vision(body.prompt, body.images.map((image) => Buffer.from(image, 'base64')), opts);
      return { description };
    } catch (err) {
      // An upstream HTTP error keeps its status (a refused image is a 400, a rate limit a 429 with its Retry-After), as chat
      // does: collapsed to a 500 the caller could not tell "send the image smaller" or "wait N seconds" from "the server is
      // broken", and retried every one of them the same way.
      if (err instanceof UpstreamHttpError) throw new HttpException(err.message, err.upstreamStatus);
      if (err instanceof OpenAI.APIError && typeof err.status === 'number' && err.status >= 400 && err.status <= 599) {
        const retryAfter = err.headers?.['retry-after'];
        if (err.status === 429 && retryAfter) res?.setHeader('Retry-After', String(retryAfter));
        throw new HttpException(err.message, err.status);
      }
      throw err;
    }
  }
}
