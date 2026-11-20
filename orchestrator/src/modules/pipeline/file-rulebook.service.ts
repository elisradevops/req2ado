import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { Prisma, PrismaClient, type FileRulebook } from '@prisma/client';
import type { CanonicalDoc } from '@req2ado/shared-ts';
import { OpenWebUiClientFactory } from '../llm/openwebui-client.factory';
import { IngestionHttpClient, IngestionHttpError, type PrestudyResult } from './ingestion-http.client';

const NO_CONNECTION = 'No model connection is configured for your account, so the file is read by its recognised headings and its shape.';

/** How long Open WebUI may take to process the uploaded file before the study goes on from the profile alone. */
const FILE_PROCESSING_TIMEOUT_MS = 60_000;

/** A rulebook as the wizard sees it. `id` is null when nothing was learned (nothing is stored for a failed study). */
export interface RulebookView {
  id: string | null;
  source: 'model' | 'user' | 'none';
  hash: string;
  rules: string[];
  warnings: unknown[];
  rulebook: Record<string, unknown>;
  /** True when a rulebook stored earlier for this file was returned and no model was asked. */
  reused: boolean;
  /** Why the study was skipped (no model connection for this user), or null. A skipped study is not a failure: the file is read by its recognised headings. */
  skipped: string | null;
  /** What the rules make of the file (counts, examples, rows not imported); null when nothing is stored (a skipped or empty study, or a rulebook stored before it was kept). */
  details: Record<string, unknown> | null;
}

export function viewOf(row: FileRulebook, reused: boolean): RulebookView {
  return {
    id: row.id,
    source: row.source as RulebookView['source'],
    hash: row.hash,
    rules: row.rules as string[],
    warnings: row.warnings as unknown[],
    rulebook: row.rulebook as Record<string, unknown>,
    reused,
    skipped: null,
    details: (row.details as Record<string, unknown> | null) ?? null,
  };
}

/** Whether ingestion studies `doc` as a document (any running text) rather than by its tables: the same test as its study/model_rules._has_running_text. */
export function studiedAsDocument(doc: Pick<CanonicalDoc, 'blocks'>): boolean {
  return doc.blocks.some((block) => !(block.kind === 'note' && block.text.startsWith('[UNSUPPORTED:')));
}

/** The sha256 of the uploaded bytes: the key a rulebook is stored under, and the one a job's file must match. */
export function fileShaOf(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * Learns, stores and reuses how a file states its structure. One rulebook per user and file: the wizard's preview, the job and a re-run all use the
 * same one, so the same file gives the same structure. A user's edit wins over a learned rulebook; a learned one is reused while the study is the same
 * (prompts, schemas, votes, code pass) and is asked for again on request. A study that learned nothing is returned but never stored.
 */
@Injectable()
export class FileRulebookService {
  private readonly logger = new Logger(FileRulebookService.name);

  constructor(
    private readonly prisma: PrismaClient,
    private readonly ingestion: IngestionHttpClient,
    private readonly clients: OpenWebUiClientFactory,
    // PRESTUDY_ATTACH_FILE_FOR_TABLES: attach the file to a table study too (off: a table's profile already covers every row).
    // OCR_LANGUAGES: the languages the job parses a scanned file with, so the study reads the same document the job builds from.
    private readonly options: { attachFileForTables?: boolean; ocrLanguages?: string } = {},
  ) {}

  /** The stored rulebook `id` when it belongs to `userId` and was made for exactly this file; otherwise null. */
  async getFor(userId: string, id: string, fileSha256: string): Promise<FileRulebook | null> {
    const row = await this.prisma.fileRulebook.findUnique({ where: { id } });
    return row && row.userId === userId && row.fileSha256 === fileSha256 ? row : null;
  }

  async learn(input: { userId: string; file: Buffer; filename: string; model?: string; relearn?: boolean; signal?: AbortSignal }): Promise<RulebookView> {
    const sha = fileShaOf(input.file);
    if (!input.relearn) {
      const user = await this.prisma.fileRulebook.findFirst({ where: { userId: input.userId, fileSha256: sha, source: 'user' }, orderBy: { createdAt: 'desc' } });
      if (user) return viewOf(user, true);
      const version = await this.ingestion.prestudyVersion();
      if (version) {
        const learned = await this.prisma.fileRulebook.findFirst({
          where: { userId: input.userId, fileSha256: sha, prestudyVersion: version, source: 'model' },
          orderBy: { createdAt: 'desc' },
        });
        if (learned) return viewOf(learned, true);
      }
    }
    // No Open WebUI connection for this user: the study is skipped, not failed (the file is read by its recognised headings and its shape).
    if (!(await this.hasConnection(input.userId))) {
      return { id: null, source: 'none', hash: '', rules: [], warnings: [], rulebook: {}, reused: false, skipped: NO_CONNECTION, details: null };
    }
    // The caller giving up (the wizard stopped waiting, or the file changed) stops the parse too, not only the model's calls after it.
    const doc = await this.ingestion.ingest(input.file, input.filename, true, 'baseline', undefined, undefined, this.ocrLanguages(), undefined, undefined, undefined, input.signal);
    const result = await this.askWithFile(input, doc);
    return this.store(input.userId, sha, input.model ?? '', result);
  }

  /**
   * The rulebook a job is built from when the wizard did not supply one (a batch file, an API call, a resubmit of an old job): the stored rulebook for the
   * file, or a fresh study. `rulebook` is null when the study was skipped (no connection); {} when it ran and learned nothing (so no later stage asks again);
   * otherwise the rulebook and its hash. A failed study throws: the caller proceeds without one.
   */
  async forJob(input: { userId: string; file: Buffer; filename: string; model?: string; signal?: AbortSignal }): Promise<{ rulebook: Record<string, unknown> | null; hash: string | null }> {
    const view = await this.learn(input);
    if (view.skipped) return { rulebook: null, hash: null };
    if (view.id === null) return { rulebook: {}, hash: null };
    return { rulebook: view.rulebook, hash: view.hash };
  }

  /** The configured OCR languages, or undefined (not sent: ingestion's own default) when none are set, as the job does. */
  private ocrLanguages(): string | undefined {
    return this.options.ocrLanguages || undefined;
  }

  private async hasConnection(userId: string): Promise<boolean> {
    try {
      await this.clients.getClientFor(userId);
      return true;
    } catch {
      return false;
    }
  }

  /** Checks a user's edit against the file; a rulebook that does not fit throws `RulebookRejected` with the reason. */
  async edit(input: { userId: string; file: Buffer; filename: string; model?: string; rulebook: Record<string, unknown> }): Promise<RulebookView> {
    const doc = await this.ingestion.ingest(input.file, input.filename, true, 'baseline', undefined, undefined, this.ocrLanguages());
    try {
      const result = await this.ingestion.prestudy(doc, { userId: input.userId, rulebook: input.rulebook });
      return this.store(input.userId, fileShaOf(input.file), input.model ?? '', result);
    } catch (err) {
      if (err instanceof IngestionHttpError && err.status === 422) throw new RulebookRejected(err.message.replace(/^Ingestion \/prestudy request failed: /, ''));
      throw err;
    }
  }

  // The hybrid route: the uploaded file is attached to the model's calls beside the profile. A failed upload or processing leaves the study on the
  // profile alone (fail open); the Open WebUI copy is always deleted afterwards. A table study is not attached (unless configured): its profile covers
  // every row, and the attached sheet made each vote's prompt about ten times longer, behind Open WebUI's own instructions. `relearn` asks the model
  // afresh instead of replaying cached answers.
  private async askWithFile(input: { userId: string; file: Buffer; filename: string; model?: string; relearn?: boolean; signal?: AbortSignal }, doc: Awaited<ReturnType<IngestionHttpClient['ingest']>>): Promise<PrestudyResult> {
    const ask = (fileId: string | undefined) =>
      this.ingestion.prestudy(doc, {
        userId: input.userId,
        ...(input.model ? { model: input.model } : {}),
        ...(fileId ? { fileId } : {}),
        ...(input.relearn ? { fresh: true } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      });
    if (!studiedAsDocument(doc) && !this.options.attachFileForTables) return ask(undefined);
    let fileId: string | undefined;
    let client: Awaited<ReturnType<OpenWebUiClientFactory['getClientFor']>> | undefined;
    try {
      client = await this.clients.getClientFor(input.userId);
      fileId = await client.uploadFile(input.file, input.filename, input.signal);
      if (!(await client.pollFileProcessed(fileId, FILE_PROCESSING_TIMEOUT_MS, input.signal))) {
        this.logger.warn('pre-study: Open WebUI did not process the file in time; studying from the profile alone');
        await this.discard(client, fileId);
        fileId = undefined;
      }
    } catch (err) {
      this.logger.warn(`pre-study: the file could not be attached (${err instanceof Error ? err.name : 'error'}); studying from the profile alone`);
      if (client && fileId) await this.discard(client, fileId);
      fileId = undefined;
    }
    try {
      return await ask(fileId);
    } finally {
      if (client && fileId) await this.discard(client, fileId);
    }
  }

  private async discard(client: { deleteFile(fileId: string): Promise<void> }, fileId: string): Promise<void> {
    try {
      await client.deleteFile(fileId);
    } catch {
      /* best effort: a leftover upload is Open WebUI's to expire */
    }
  }

  private async store(userId: string, fileSha256: string, model: string, result: PrestudyResult): Promise<RulebookView> {
    if (result.source === 'none') {
      return { id: null, source: 'none', hash: result.hash, rules: result.rules, warnings: result.warnings, rulebook: result.rulebook, reused: false, skipped: null, details: null };
    }
    const row = await this.prisma.fileRulebook.create({
      data: {
        userId,
        fileSha256,
        prestudyVersion: result.version,
        model,
        source: result.source,
        rulebook: result.rulebook as Prisma.InputJsonValue,
        hash: result.hash,
        rules: result.rules as Prisma.InputJsonValue,
        warnings: result.warnings as Prisma.InputJsonValue,
        ...(result.details ? { details: result.details as Prisma.InputJsonValue } : {}),
      },
    });
    return viewOf(row, false);
  }
}

/** A user's edit that does not fit the file; `message` is the reason, shown to the user. */
export class RulebookRejected extends Error {}
