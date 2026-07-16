import { ConflictException, NotFoundException } from '@nestjs/common';
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
