import type { CanonicalDoc } from '@req2ado/shared-ts';
import { OpenWebUiClientFactory } from '../llm/openwebui-client.factory';
import { FileRulebookService } from './file-rulebook.service';
import { IngestionHttpClient } from './ingestion-http.client';

export interface StudyPreviewOptions {
  /** STUDY_PHASE: off, the wizard has no Study step. */
  enabled: boolean;
  /** The deployment's default chat model (LLM_CHAT_MODEL), the worker's last resort too. */
  defaultModel: string;
  /** The OCR language packs the pipeline parses with, so a scanned PDF reads the same here. */
  ocrLanguages?: string;
}

export interface StudyPreviewInput {
  userId: string;
  file: Buffer;
  filename: string;
  mode: 'baseline' | 'survey';
  model?: string;
  /** The rulebook the wizard stored for this file (submitted with the job): the Study reads its tables the way the job will. */
  rulebookId?: string;
  signal?: AbortSignal;
}

/**
 * The wizard's "Reading and analyzing the document" step: the same Study the job will read (the same text, rulebook, user and model), so
 * the job reuses the result ingestion caches instead of reading again. It runs while the wizard waits, as one streamed request the browser
 * holds: closing it stops the reading.
 */
export class StudyPreviewService {
  constructor(
    private readonly ingestion: IngestionHttpClient,
    private readonly clients: OpenWebUiClientFactory,
    private readonly fileRulebooks: FileRulebookService | undefined,
    private readonly options: StudyPreviewOptions,
  ) {}

  /** The streamed Study, or null when this job would not read one (the switch is off, or a BASELINE job of a user with no model connection). */
  async open(input: StudyPreviewInput, fileSha256: string): Promise<ReadableStream<Uint8Array> | null> {
    if (!this.options.enabled) return null;
    const chatModel = await this.connectedChatModel(input.userId);
    if (input.mode === 'baseline' && chatModel === null) return null;
    // The worker's own resolution (pipeline.worker.ts resolveDefaultChatModel): the chosen model, the connection's, the deployment's.
    const model = input.model ?? chatModel ?? this.options.defaultModel;
    let rulebook: Record<string, unknown> | undefined;
    if (input.rulebookId && this.fileRulebooks) {
      const row = await this.fileRulebooks.getFor(input.userId, input.rulebookId, fileSha256);
      if (row) rulebook = row.rulebook as Record<string, unknown>;
    }
    // Parsed the way the rules step parses (text, tables and figure positions are the job's; captions are not part of the Study's text).
    const doc: CanonicalDoc = await this.ingestion.ingest(
      input.file, input.filename, true, 'baseline', undefined, undefined, this.options.ocrLanguages || undefined, undefined, undefined, undefined, input.signal,
    );
    return this.ingestion.studyStream(rulebook ? { ...doc, rulebook } : doc, { userId: input.userId, model, signal: input.signal });
  }

  private async connectedChatModel(userId: string): Promise<string | null> {
    try {
      return (await this.clients.getClientFor(userId)).chatModel;
    } catch {
      return null;
    }
  }
}
