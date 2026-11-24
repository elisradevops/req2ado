import { StudyPreviewService } from '../src/modules/pipeline/study-preview.service';

describe('StudyPreviewService', () => {
  const parsed = { blocks: [{ id: 'b0' }] };
  const stream = {} as ReadableStream<Uint8Array>;

  function make(overrides: { enabled?: boolean; connection?: string | null; rulebook?: object | null } = {}) {
    const ingestion = { ingest: jest.fn().mockResolvedValue(parsed), studyStream: jest.fn().mockResolvedValue(stream) };
    const clients = {
      getClientFor: jest.fn().mockImplementation(async () => {
        if (overrides.connection === null) throw new Error('no connection');
        return { chatModel: overrides.connection ?? 'user-model' };
      }),
    };
    const fileRulebooks = { getFor: jest.fn().mockResolvedValue(overrides.rulebook === undefined ? null : overrides.rulebook) };
    const service = new StudyPreviewService(ingestion as any, clients as any, fileRulebooks as any, {
      enabled: overrides.enabled ?? true,
      defaultModel: 'deployment-model',
      ocrLanguages: 'heb+eng',
    });
    return { service, ingestion, fileRulebooks };
  }

  const input = { userId: 'u1', file: Buffer.from('x'), filename: 'x.docx', mode: 'survey' as const };

  it('reads nothing while the switch is off', async () => {
    const { service, ingestion } = make({ enabled: false });
    expect(await service.open(input, 'sha')).toBeNull();
    expect(ingestion.ingest).not.toHaveBeenCalled();
  });

  it('reads nothing for a BASELINE job of a user with no model connection, but does for a connected one', async () => {
    expect(await make({ connection: null }).service.open({ ...input, mode: 'baseline' }, 'sha')).toBeNull();
    expect(await make().service.open({ ...input, mode: 'baseline' }, 'sha')).toBe(stream);
  });

  it('resolves the model as the worker does: the chosen one, else the connection\'s, else the deployment\'s', async () => {
    const chosen = make();
    await chosen.service.open({ ...input, model: 'chosen' }, 'sha');
    expect(chosen.ingestion.studyStream).toHaveBeenCalledWith(parsed, expect.objectContaining({ model: 'chosen', userId: 'u1' }));

    const connection = make();
    await connection.service.open(input, 'sha');
    expect(connection.ingestion.studyStream).toHaveBeenCalledWith(parsed, expect.objectContaining({ model: 'user-model' }));

    const deployment = make({ connection: null });
    await deployment.service.open(input, 'sha');
    expect(deployment.ingestion.studyStream).toHaveBeenCalledWith(parsed, expect.objectContaining({ model: 'deployment-model' }));
  });

  it('parses as the rules step does and reads the tables by the rulebook the wizard stored for this file', async () => {
    const { service, ingestion, fileRulebooks } = make({ rulebook: { rulebook: { tables: {} }, hash: 'h' } });
    const signal = new AbortController().signal;
    await service.open({ ...input, rulebookId: 'rb1', signal }, 'sha-1');
    expect(fileRulebooks.getFor).toHaveBeenCalledWith('u1', 'rb1', 'sha-1');
    expect(ingestion.ingest).toHaveBeenCalledWith(Buffer.from('x'), 'x.docx', true, 'baseline', undefined, undefined, 'heb+eng', undefined, undefined, undefined, signal);
    expect(ingestion.studyStream).toHaveBeenCalledWith({ ...parsed, rulebook: { tables: {} } }, expect.objectContaining({ signal }));
  });
});
