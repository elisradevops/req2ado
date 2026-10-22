import { ConflictException, NotFoundException } from '@nestjs/common';
import axios from 'axios';
import { ChatService } from '../src/modules/chat/chat.service';

function makeDiffJob(overrides: Partial<{ status: string; entryOverrides: Record<string, unknown> }> = {}) {
  return {
    id: 'job-1',
    status: overrides.status ?? 'diff_ready',
    areaPath: 'Project\\Area1',
    dryRunDiff: [
      {
        localId: 'n0',
        type: 'Requirement',
        title: 'T',
        description: 'D',
        action: 'create',
        excluded: false,
        childType: null,
        qualityIssues: [],
        ...overrides.entryOverrides,
      },
    ],
  };
}

describe('ChatService.sendTurn', () => {
  it('throws NotFoundException when the job does not exist', async () => {
    const prisma = { job: { findUnique: jest.fn().mockResolvedValue(null) }, chatMessage: { create: jest.fn() } };
    const service = new ChatService(prisma as any, 'http://ingestion:8000', { set: jest.fn() } as any);
    await expect(service.sendTurn('job-1', 'n0', 'hi', undefined)).rejects.toThrow(NotFoundException);
  });

  it('throws ConflictException when job.status is not diff_ready', async () => {
    const prisma = { job: { findUnique: jest.fn().mockResolvedValue(makeDiffJob({ status: 'running' })) }, chatMessage: { create: jest.fn() } };
    const service = new ChatService(prisma as any, 'http://ingestion:8000', { set: jest.fn() } as any);
    await expect(service.sendTurn('job-1', 'n0', 'hi', undefined)).rejects.toThrow(ConflictException);
  });

  it('throws NotFoundException when the diff entry does not exist', async () => {
    const prisma = { job: { findUnique: jest.fn().mockResolvedValue(makeDiffJob()) }, chatMessage: { create: jest.fn() } };
    const service = new ChatService(prisma as any, 'http://ingestion:8000', { set: jest.fn() } as any);
    await expect(service.sendTurn('job-1', 'does-not-exist', 'hi', undefined)).rejects.toThrow(NotFoundException);
  });

  it('throws ConflictException for a non-create-action entry', async () => {
    const prisma = {
      job: { findUnique: jest.fn().mockResolvedValue(makeDiffJob({ entryOverrides: { action: 'reuse' } })) },
      chatMessage: { create: jest.fn() },
    };
    const service = new ChatService(prisma as any, 'http://ingestion:8000', { set: jest.fn() } as any);
    await expect(service.sendTurn('job-1', 'n0', 'hi', undefined)).rejects.toThrow(ConflictException);
  });

  it('throws ConflictException for an excluded entry', async () => {
    const prisma = {
      job: { findUnique: jest.fn().mockResolvedValue(makeDiffJob({ entryOverrides: { excluded: true } })) },
      chatMessage: { create: jest.fn() },
    };
    const service = new ChatService(prisma as any, 'http://ingestion:8000', { set: jest.fn() } as any);
    await expect(service.sendTurn('job-1', 'n0', 'hi', undefined)).rejects.toThrow(ConflictException);
  });

  it('persists the user turn before returning', async () => {
    const create = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      job: { findUnique: jest.fn().mockResolvedValue(makeDiffJob()) },
      chatMessage: { create, findMany: jest.fn().mockResolvedValue([]) },
    };
    const service = new ChatService(prisma as any, 'http://ingestion:8000', { set: jest.fn() } as any);

    await service.sendTurn('job-1', 'n0', 'hello there', 'llama3.1');

    expect(create).toHaveBeenCalledWith({
      data: { jobId: 'job-1', localId: 'n0', role: 'user', content: 'hello there', model: 'llama3.1' },
    });
  });
});

describe('ChatService.sendTurn: what ingestion is told about the item', () => {
  it("sends the item's score per quality category so a rewrite can be aimed at the weakest one", async () => {
    const post = jest.spyOn(axios, 'post').mockResolvedValue({ data: {} } as never);
    const prisma = {
      job: { findUnique: jest.fn().mockResolvedValue({ ...makeDiffJob({ entryOverrides: { qualityCategoryScores: { Testable: 40, Clear: 90 } } }), userId: 'user-1' }) },
      chatMessage: { create: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
    };
    await new ChatService(prisma as any, 'http://ingestion:8000', { set: jest.fn() } as any).sendTurn('job-1', 'n0', 'rewrite it', undefined);

    const payload = post.mock.calls[0][1] as { item: Record<string, unknown> };
    expect(payload.item.qualityCategoryScores).toEqual({ Testable: 40, Clear: 90 });
    post.mockRestore();
  });

  it('sends null when the item has no category scores', async () => {
    const post = jest.spyOn(axios, 'post').mockResolvedValue({ data: {} } as never);
    const prisma = { job: { findUnique: jest.fn().mockResolvedValue({ ...makeDiffJob(), userId: 'user-1' }) }, chatMessage: { create: jest.fn(), findMany: jest.fn().mockResolvedValue([]) } };
    await new ChatService(prisma as any, 'http://ingestion:8000', { set: jest.fn() } as any).sendTurn('job-1', 'n0', 'why?', undefined);
    expect((post.mock.calls[0][1] as { item: Record<string, unknown> }).item.qualityCategoryScores).toBeNull();
    post.mockRestore();
  });
});

describe('ChatService.sendTurn: which model answers', () => {
  const run = async (jobModel: string | null, picked: string | undefined) => {
    const post = jest.spyOn(axios, 'post').mockResolvedValue({ data: {} } as never);
    const create = jest.fn();
    const prisma = {
      job: { findUnique: jest.fn().mockResolvedValue({ ...makeDiffJob(), userId: 'user-1', model: jobModel }) },
      chatMessage: { create, findMany: jest.fn().mockResolvedValue([]) },
    };
    await new ChatService(prisma as any, 'http://ingestion:8000', { set: jest.fn() } as any).sendTurn('job-1', 'n0', 'improve this', picked);
    const sent = (post.mock.calls[0][1] as { model: string | null }).model;
    post.mockRestore();
    return { sent, stored: (create.mock.calls[0][0] as { data: { model: string | null } }).data.model };
  };

  it('uses the model the job was analysed with when none is picked (not the orchestrator\'s own default)', async () => {
    expect(await run('claude-opus-4-8', undefined)).toEqual({ sent: 'claude-opus-4-8', stored: 'claude-opus-4-8' });
  });

  it('uses the picked model when there is one', async () => {
    expect(await run('claude-opus-4-8', 'OpenAI/gpt-5.6-terra')).toEqual({ sent: 'OpenAI/gpt-5.6-terra', stored: 'OpenAI/gpt-5.6-terra' });
  });

  it('leaves it to the server default only when the job has no model either', async () => {
    expect(await run(null, undefined)).toEqual({ sent: null, stored: null });
  });
});

describe('ChatService.sendTurn: where the item sits', () => {
  it('sends the item its parents, neighbours, linked items and captions, built from the job itself', async () => {
    const post = jest.spyOn(axios, 'post').mockResolvedValue({ data: {} } as never);
    const job = {
      id: 'job-1',
      status: 'diff_ready',
      userId: 'user-1',
      filename: 'AirPro.docx',
      figureDescriptions: [{ figureIndex: 1, figureId: 'fig-1', name: 'State machine', caption: 'Idle to locked.' }],
      tableDescriptions: [],
      dryRunDiff: [
        { localId: 'f1', parentLocalId: null, type: 'Feature', title: 'Carrier acquisition', description: 'How lock is found.', action: 'create' },
        { localId: 'n0', parentLocalId: 'f1', type: 'Requirement', title: 'T', description: 'D', action: 'create', figureIds: ['fig-1'] },
        { localId: 'n1', parentLocalId: 'f1', type: 'Requirement', title: 'Neighbour', description: 'N', action: 'create' },
      ],
    };
    const prisma = { job: { findUnique: jest.fn().mockResolvedValue(job) }, chatMessage: { create: jest.fn(), findMany: jest.fn().mockResolvedValue([]) } };
    await new ChatService(prisma as any, 'http://ingestion:8000', { set: jest.fn() } as any).sendTurn('job-1', 'n0', 'improve this', undefined);

    const context = (post.mock.calls[0][1] as { item: { context: Record<string, unknown> } }).item.context;
    expect(context).toEqual({
      documentName: 'AirPro.docx',
      parents: [{ type: 'Feature', title: 'Carrier acquisition', description: 'How lock is found.' }],
      siblings: [{ title: 'Neighbour' }],
      linked: [],
      figures: [{ name: 'State machine', caption: 'Idle to locked.' }],
      tables: [],
    });
    post.mockRestore();
  });
});

describe('ChatService.getHistory', () => {
  it('returns the last 50 turns ordered oldest-first', async () => {
    const rows = [{ id: '1', jobId: 'job-1', localId: 'n0', role: 'user', content: 'hi', proposedTitle: null, proposedDescription: null, model: null, createdAt: new Date('2026-01-01') }];
    const findMany = jest.fn().mockResolvedValue(rows);
    const prisma = { chatMessage: { findMany } };
    const service = new ChatService(prisma as any, 'http://ingestion:8000', { set: jest.fn() } as any);

    const history = await service.getHistory('job-1', 'n0');

    expect(findMany).toHaveBeenCalledWith({ where: { jobId: 'job-1', localId: 'n0' }, orderBy: { createdAt: 'asc' }, take: 50 });
    expect(history).toEqual([{ id: '1', role: 'user', content: 'hi', proposedTitle: null, proposedDescription: null, model: null, createdAt: rows[0].createdAt }]);
  });
});

describe('ChatService.stopTurn', () => {
  it('sets the abort key with a short TTL', async () => {
    const set = jest.fn().mockResolvedValue(undefined);
    const service = new ChatService({} as any, 'http://ingestion:8000', { set } as any);

    await service.stopTurn('job-1', 'n0');

    expect(set).toHaveBeenCalledWith('chat:abort:job-1:n0', '1', 'EX', 30);
  });
});

describe('ChatService.persistAssistantTurn', () => {
  it('parses jobId/localId from the channel name and persists an assistant row', async () => {
    const create = jest.fn().mockResolvedValue(undefined);
    const service = new ChatService({ chatMessage: { create } } as any, 'http://ingestion:8000', { set: jest.fn() } as any);

    await service.persistAssistantTurn('chat:job-1:n0', {
      message: 'Here you go', proposedTitle: 'New title', proposedDescription: null, model: 'llama3.1',
    });

    expect(create).toHaveBeenCalledWith({
      data: { jobId: 'job-1', localId: 'n0', role: 'assistant', content: 'Here you go', proposedTitle: 'New title', proposedDescription: null, model: 'llama3.1' },
    });
  });
});
