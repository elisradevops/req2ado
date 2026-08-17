import { BadGatewayException } from '@nestjs/common';
import { Queue } from 'bullmq';
import { JobsService } from '../src/modules/pipeline/jobs.service';
import { toAdoDescriptionHtml } from '../src/modules/pipeline/description-html';
import { IngestionHttpError } from '../src/modules/pipeline/ingestion-http.client';

describe('JobsService.confirm', () => {
  it('creates items in tree order and links each child to its already-created parent', async () => {
    const createWorkItem = jest.fn()
      .mockResolvedValueOnce({ id: 100 }) // parent
      .mockResolvedValueOnce({ id: 101 }); // child
    const linkParentChild = jest.fn().mockResolvedValue(undefined);
    const record = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1',
          status: 'diff_ready', state: 'Proposed',
          areaPath: 'Project\\Area1',
          dryRunDiff: [
            { localId: 'n0', parentLocalId: null, type: 'Feature', title: 'Parent', description: 'd0', action: 'create', existingAdoId: null, sourceHash: 'h0', customerId: null, sourceRef: null, tags: [] },
            { localId: 'n1', parentLocalId: 'n0', type: 'Requirement', title: 'Child', description: 'd1', action: 'create', existingAdoId: null, sourceHash: 'h1', customerId: null, sourceRef: null, tags: [] },
          ],
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      auditEntry: { create: jest.fn().mockResolvedValue(undefined) },

      createdItemMapping: { findMany: jest.fn().mockResolvedValue([]), upsert: jest.fn().mockResolvedValue(undefined), update: jest.fn().mockResolvedValue(undefined) },
    };
    const service = new JobsService(
      prisma as any,
      { createWorkItem, linkParentChild, discoverWorkItemTypeCategories: jest.fn().mockResolvedValue({ Epic: 'Epic', Feature: 'Feature', Requirement: 'Requirement' }) } as any,
      { record } as any,
      { upsertDedupEntriesBatch: jest.fn().mockResolvedValue(undefined) } as any,
      'redis://unused',
    );

    const result = await service.confirm('job-1');

    expect(result).toEqual({ status: 'succeeded', createdCount: 2 });
    expect(linkParentChild).toHaveBeenCalledWith(101, 100, undefined);
  });

  it('publishes a writing stage and per-sub-phase narration when a JobEventsPublisher is provided', async () => {
    // Regression coverage: previously JobsService held no
    // JobEventsPublisher at all, so confirm() was structurally incapable
    // of publishing anything -- a 'writing' job showed zero progress UI.
    const createWorkItem = jest.fn().mockResolvedValue({ id: 100 });
    const record = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1',
          status: 'diff_ready', state: 'Proposed',
          areaPath: 'Project\\Area1',
          dryRunDiff: [
            { localId: 'n0', parentLocalId: null, type: 'Feature', title: 'Parent', description: 'd0', action: 'create', existingAdoId: null, sourceHash: 'h0', customerId: null, sourceRef: null, tags: [] },
          ],
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      auditEntry: { create: jest.fn().mockResolvedValue(undefined) },
      createdItemMapping: { findMany: jest.fn().mockResolvedValue([]), upsert: jest.fn().mockResolvedValue(undefined), update: jest.fn().mockResolvedValue(undefined) },
    };
    const publish = jest.fn().mockResolvedValue(undefined);
    const publishNarration = jest.fn().mockResolvedValue(undefined);
    const service = new JobsService(
      prisma as any,
      { createWorkItem, linkParentChild: jest.fn(), discoverWorkItemTypeCategories: jest.fn().mockResolvedValue({ Epic: 'Epic', Feature: 'Feature', Requirement: 'Requirement' }) } as any,
      { record } as any,
      { upsertDedupEntriesBatch: jest.fn().mockResolvedValue(undefined) } as any,
      'redis://unused',
      undefined,
      undefined,
      undefined,
      undefined,
      { publish, publishNarration } as any,
    );

    await service.confirm('job-1');

    expect(publish).toHaveBeenCalledWith('job-1', 'writing');
    expect(publishNarration).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({ phase: 'writing', writeSubPhase: 'create', blocksDone: 1, blocksTotal: 1 }),
    );
  });

  it('publishes an unconditional "create" kick-off narration with blocksDone: 0 before the first item resolves', async () => {
    // Regression coverage: previously the first 'create' narration only
    // fired from INSIDE the mapWithConcurrency callback, once item #1
    // actually finished -- so the ticker sat frozen on 'discover_types' for
    // however long the first ADO create round-trip took, however long that
    // was. This kick-off must exist and must come before the blocksDone:1
    // event, not just exist somewhere in the call history.
    const createWorkItem = jest.fn().mockResolvedValue({ id: 100 });
    const record = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1',
          status: 'diff_ready', state: 'Proposed',
          areaPath: 'Project\\Area1',
          dryRunDiff: [
            { localId: 'n0', parentLocalId: null, type: 'Feature', title: 'Parent', description: 'd0', action: 'create', existingAdoId: null, sourceHash: 'h0', customerId: null, sourceRef: null, tags: [] },
          ],
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      auditEntry: { create: jest.fn().mockResolvedValue(undefined) },
      createdItemMapping: { findMany: jest.fn().mockResolvedValue([]), upsert: jest.fn().mockResolvedValue(undefined), update: jest.fn().mockResolvedValue(undefined) },
    };
    const publishNarration = jest.fn().mockResolvedValue(undefined);
    const service = new JobsService(
      prisma as any,
      { createWorkItem, linkParentChild: jest.fn(), discoverWorkItemTypeCategories: jest.fn().mockResolvedValue({ Epic: 'Epic', Feature: 'Feature', Requirement: 'Requirement' }) } as any,
      { record } as any,
      { upsertDedupEntriesBatch: jest.fn().mockResolvedValue(undefined) } as any,
      'redis://unused',
      undefined,
      undefined,
      undefined,
      undefined,
      { publish: jest.fn(), publishNarration } as any,
    );

    await service.confirm('job-1');

    const createCalls = publishNarration.mock.calls.filter(([, event]) => event.writeSubPhase === 'create');
    expect(createCalls[0][1]).toMatchObject({ blocksDone: 0, blocksTotal: 1 });
    expect(createCalls[createCalls.length - 1][1]).toMatchObject({ blocksDone: 1, blocksTotal: 1 });
    expect(createCalls.length).toBeGreaterThanOrEqual(2);
  });

  it('publishes a "link_parents" narration even when there is nothing to link (toLink is empty)', async () => {
    // Regression coverage: a single-root diff with no parent/child relations
    // previously published nothing at all for this sub-phase -- the ticker
    // stayed frozen on the last 'create' narration for the rest of confirm(),
    // even though linking had (trivially) already finished.
    const createWorkItem = jest.fn().mockResolvedValue({ id: 100 });
    const record = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1',
          status: 'diff_ready', state: 'Proposed',
          areaPath: 'Project\\Area1',
          dryRunDiff: [
            { localId: 'n0', parentLocalId: null, type: 'Feature', title: 'Only node', description: 'd0', action: 'create', existingAdoId: null, sourceHash: 'h0', customerId: null, sourceRef: null, tags: [] },
          ],
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      auditEntry: { create: jest.fn().mockResolvedValue(undefined) },
      createdItemMapping: { findMany: jest.fn().mockResolvedValue([]), upsert: jest.fn().mockResolvedValue(undefined), update: jest.fn().mockResolvedValue(undefined) },
    };
    const publishNarration = jest.fn().mockResolvedValue(undefined);
    const service = new JobsService(
      prisma as any,
      { createWorkItem, linkParentChild: jest.fn(), discoverWorkItemTypeCategories: jest.fn().mockResolvedValue({ Epic: 'Epic', Feature: 'Feature', Requirement: 'Requirement' }) } as any,
      { record } as any,
      { upsertDedupEntriesBatch: jest.fn().mockResolvedValue(undefined) } as any,
      'redis://unused',
      undefined,
      undefined,
      undefined,
      undefined,
      { publish: jest.fn(), publishNarration } as any,
    );

    await service.confirm('job-1');

    expect(publishNarration).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({ phase: 'writing', writeSubPhase: 'link_parents', blocksDone: 0, blocksTotal: 0 }),
    );
  });

  it('publishes a "trace_links" narration even when there are no trace links to write (toTraceLink is empty)', async () => {
    const createWorkItem = jest.fn().mockResolvedValue({ id: 100 });
    const record = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1',
          status: 'diff_ready', state: 'Proposed',
          areaPath: 'Project\\Area1',
          dryRunDiff: [
            { localId: 'n0', parentLocalId: null, type: 'Feature', title: 'Only node', description: 'd0', action: 'create', existingAdoId: null, sourceHash: 'h0', customerId: null, sourceRef: null, tags: [] },
          ],
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      auditEntry: { create: jest.fn().mockResolvedValue(undefined) },
      createdItemMapping: { findMany: jest.fn().mockResolvedValue([]), upsert: jest.fn().mockResolvedValue(undefined), update: jest.fn().mockResolvedValue(undefined) },
    };
    const publishNarration = jest.fn().mockResolvedValue(undefined);
    const service = new JobsService(
      prisma as any,
      { createWorkItem, linkParentChild: jest.fn(), discoverWorkItemTypeCategories: jest.fn().mockResolvedValue({ Epic: 'Epic', Feature: 'Feature', Requirement: 'Requirement' }) } as any,
      { record } as any,
      { upsertDedupEntriesBatch: jest.fn().mockResolvedValue(undefined) } as any,
      'redis://unused',
      undefined,
      undefined,
      undefined,
      undefined,
      { publish: jest.fn(), publishNarration } as any,
    );

    await service.confirm('job-1');

    expect(publishNarration).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({ phase: 'writing', writeSubPhase: 'trace_links', blocksDone: 0, blocksTotal: 0 }),
    );
  });

  it('creates work items using the project\'s REAL work-item type name, not req2ado\'s internal Epic/Feature/Requirement label', async () => {
    // Confirmed real bug: entry.type ("Requirement") was previously sent
    // straight to ADO as the literal type name -- 404s on any non-CMMI
    // process template. An Agile project's real Requirement-category type
    // is "User Story".
    const createWorkItem = jest.fn()
      .mockResolvedValueOnce({ id: 100 })
      .mockResolvedValueOnce({ id: 101 });
    const linkParentChild = jest.fn().mockResolvedValue(undefined);
    const discoverWorkItemTypeCategories = jest.fn().mockResolvedValue({ Epic: 'Epic', Feature: 'Feature', Requirement: 'User Story' });
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1',
          status: 'diff_ready', state: 'Proposed',
          areaPath: 'AgileProject\\Area1',
          dryRunDiff: [
            { localId: 'n0', parentLocalId: null, type: 'Feature', title: 'Parent', description: 'd0', action: 'create', existingAdoId: null, sourceHash: 'h0', customerId: null, sourceRef: null, tags: [] },
            { localId: 'n1', parentLocalId: 'n0', type: 'Requirement', title: 'Child', description: 'd1', action: 'create', existingAdoId: null, sourceHash: 'h1', customerId: null, sourceRef: null, tags: [] },
          ],
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      auditEntry: { create: jest.fn().mockResolvedValue(undefined) },
      createdItemMapping: { findMany: jest.fn().mockResolvedValue([]), upsert: jest.fn().mockResolvedValue(undefined), update: jest.fn().mockResolvedValue(undefined) },
    };
    const service = new JobsService(
      prisma as any,
      { createWorkItem, linkParentChild, discoverWorkItemTypeCategories } as any,
      { record: jest.fn() } as any,
      { upsertDedupEntriesBatch: jest.fn().mockResolvedValue(undefined) } as any,
      'redis://unused',
    );

    await service.confirm('job-1');

    expect(discoverWorkItemTypeCategories).toHaveBeenCalledWith('AgileProject', undefined);
    expect(createWorkItem.mock.calls[0][0]).toBe('Feature');
    expect(createWorkItem.mock.calls[1][0]).toBe('User Story');
  });

  it('links a child to a REUSED parent (existingAdoId), not just newly-created parents', async () => {
    const createWorkItem = jest.fn().mockResolvedValueOnce({ id: 101 });
    const linkParentChild = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1', status: 'diff_ready', state: 'Proposed', areaPath: 'Project\\Area1',
          dryRunDiff: [
            { localId: 'n0', parentLocalId: null, type: 'Feature', title: 'Parent', description: 'd0', action: 'reuse', existingAdoId: 42, sourceHash: 'h0', customerId: null, sourceRef: null, tags: [] },
            { localId: 'n1', parentLocalId: 'n0', type: 'Requirement', title: 'Child', description: 'd1', action: 'create', existingAdoId: null, sourceHash: 'h1', customerId: null, sourceRef: null, tags: [] },
          ],
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      auditEntry: { create: jest.fn().mockResolvedValue(undefined) },

      createdItemMapping: { findMany: jest.fn().mockResolvedValue([]), upsert: jest.fn().mockResolvedValue(undefined), update: jest.fn().mockResolvedValue(undefined) },
    };
    const service = new JobsService(
      prisma as any,
      { createWorkItem, linkParentChild, discoverWorkItemTypeCategories: jest.fn().mockResolvedValue({ Epic: 'Epic', Feature: 'Feature', Requirement: 'Requirement' }) } as any,
      { record: jest.fn() } as any,
      { upsertDedupEntriesBatch: jest.fn().mockResolvedValue(undefined) } as any,
      'redis://unused',
    );

    await service.confirm('job-1');

    expect(linkParentChild).toHaveBeenCalledWith(101, 42, undefined);
  });

  it('writes AreaPath, State, and a runtime-resolved Customer ID field on every created item', async () => {
    const createWorkItem = jest.fn().mockResolvedValue({ id: 200 });
    const discoverFields = jest
      .fn()
      .mockResolvedValue(['System.Title', 'System.Description', 'Custom.CustomerRequirementId']);
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1', status: 'diff_ready', state: 'Proposed', areaPath: 'Project\\Area1',
          dryRunDiff: [
            { localId: 'n0', parentLocalId: null, type: 'Requirement', title: 'T', description: 'D', action: 'create', existingAdoId: null, sourceHash: 'h0', customerId: 'CUST-1', sourceRef: null, tags: [] },
          ],
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      auditEntry: { create: jest.fn().mockResolvedValue(undefined) },

      createdItemMapping: { findMany: jest.fn().mockResolvedValue([]), upsert: jest.fn().mockResolvedValue(undefined), update: jest.fn().mockResolvedValue(undefined) },
    };
    const service = new JobsService(
      prisma as any,
      { createWorkItem, linkParentChild: jest.fn(), discoverFields, discoverWorkItemTypeCategories: jest.fn().mockResolvedValue({ Epic: 'Epic', Feature: 'Feature', Requirement: 'Requirement' }) } as any,
      { record: jest.fn() } as any,
      { upsertDedupEntriesBatch: jest.fn().mockResolvedValue(undefined) } as any,
      'redis://unused',
    );

    await service.confirm('job-1');

    expect(discoverFields).toHaveBeenCalledWith('Requirement', undefined);
    expect(createWorkItem).toHaveBeenCalledWith(
      'Requirement',
      {
        'System.Title': 'T',
        'System.Description': toAdoDescriptionHtml('D'),
        'System.State': 'Proposed',
        'System.AreaPath': 'Project\\Area1',
        'Custom.CustomerRequirementId': 'CUST-1',
      },
      undefined,
    );
  });

  it('falls back to a System.Tags entry when no candidate Customer ID field is discovered, rather than dropping it entirely', async () => {
    const createWorkItem = jest.fn().mockResolvedValue({ id: 201 });
    const discoverFields = jest.fn().mockResolvedValue(['System.Title', 'System.Description']);
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1', status: 'diff_ready', state: 'Proposed', areaPath: 'Project\\Area1',
          dryRunDiff: [
            { localId: 'n0', parentLocalId: null, type: 'Requirement', title: 'T', description: 'D', action: 'create', existingAdoId: null, sourceHash: 'h0', customerId: 'CUST-1', sourceRef: null, tags: [] },
          ],
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      auditEntry: { create: jest.fn().mockResolvedValue(undefined) },

      createdItemMapping: { findMany: jest.fn().mockResolvedValue([]), upsert: jest.fn().mockResolvedValue(undefined), update: jest.fn().mockResolvedValue(undefined) },
    };
    const service = new JobsService(
      prisma as any,
      { createWorkItem, linkParentChild: jest.fn(), discoverFields, discoverWorkItemTypeCategories: jest.fn().mockResolvedValue({ Epic: 'Epic', Feature: 'Feature', Requirement: 'Requirement' }) } as any,
      { record: jest.fn() } as any,
      { upsertDedupEntriesBatch: jest.fn().mockResolvedValue(undefined) } as any,
      'redis://unused',
    );

    await service.confirm('job-1');

    expect(createWorkItem).toHaveBeenCalledWith(
      'Requirement',
      {
        'System.Title': 'T',
        'System.Description': toAdoDescriptionHtml('D'),
        'System.State': 'Proposed',
        'System.AreaPath': 'Project\\Area1',
        'System.Tags': 'CustomerId:CUST-1',
      },
      undefined,
    );
  });

  it('combines the CustomerId fallback tag with real classification tags in one System.Tags value', async () => {
    const createWorkItem = jest.fn().mockResolvedValue({ id: 201 });
    const discoverFields = jest.fn().mockResolvedValue(['System.Title', 'System.Description']);
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1', status: 'diff_ready', state: 'Proposed', areaPath: 'Project\\Area1',
          dryRunDiff: [
            {
              localId: 'n0', parentLocalId: null, type: 'Requirement', title: 'T', description: 'D',
              action: 'create', existingAdoId: null, sourceHash: 'h0', customerId: 'CUST-1',
              sourceRef: null, tags: ['functional'],
            },
          ],
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      auditEntry: { create: jest.fn().mockResolvedValue(undefined) },

      createdItemMapping: { findMany: jest.fn().mockResolvedValue([]), upsert: jest.fn().mockResolvedValue(undefined), update: jest.fn().mockResolvedValue(undefined) },
    };
    const service = new JobsService(
      prisma as any,
      { createWorkItem, linkParentChild: jest.fn(), discoverFields, discoverWorkItemTypeCategories: jest.fn().mockResolvedValue({ Epic: 'Epic', Feature: 'Feature', Requirement: 'Requirement' }) } as any,
      { record: jest.fn() } as any,
      { upsertDedupEntriesBatch: jest.fn().mockResolvedValue(undefined) } as any,
      'redis://unused',
    );

    await service.confirm('job-1');

    expect(createWorkItem.mock.calls[0][1]['System.Tags']).toBe('functional; CustomerId:CUST-1');
  });

  it('uses a configurable Customer ID candidate list instead of the hardcoded default', async () => {
    const createWorkItem = jest.fn().mockResolvedValue({ id: 205 });
    const discoverFields = jest.fn().mockResolvedValue(['Custom.OrgSpecificCustomerRef']);
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1', status: 'diff_ready', state: 'Proposed', areaPath: 'Project\\Area1',
          dryRunDiff: [
            { localId: 'n0', parentLocalId: null, type: 'Requirement', title: 'T', description: 'D', action: 'create', existingAdoId: null, sourceHash: 'h0', customerId: 'CUST-1', sourceRef: null, tags: [] },
          ],
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      auditEntry: { create: jest.fn().mockResolvedValue(undefined) },

      createdItemMapping: { findMany: jest.fn().mockResolvedValue([]), upsert: jest.fn().mockResolvedValue(undefined), update: jest.fn().mockResolvedValue(undefined) },
    };
    const service = new JobsService(
      prisma as any,
      { createWorkItem, linkParentChild: jest.fn(), discoverFields, discoverWorkItemTypeCategories: jest.fn().mockResolvedValue({ Epic: 'Epic', Feature: 'Feature', Requirement: 'Requirement' }) } as any,
      { record: jest.fn() } as any,
      { upsertDedupEntriesBatch: jest.fn().mockResolvedValue(undefined) } as any,
      'redis://unused',
      'Proposed',
      8,
      ['Custom.OrgSpecificCustomerRef'],
    );

    await service.confirm('job-1');

    expect(createWorkItem.mock.calls[0][1]['Custom.OrgSpecificCustomerRef']).toBe('CUST-1');
  });

  it('writes a runtime-resolved source traceability field on every created item that has a sourceRef', async () => {
    const createWorkItem = jest.fn().mockResolvedValue({ id: 202 });
    const discoverFields = jest
      .fn()
      .mockResolvedValue(['System.Title', 'System.Description', 'Custom.SourceDocument']);
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1', status: 'diff_ready', state: 'Proposed', areaPath: 'Project\\Area1',
          dryRunDiff: [
            {
              localId: 'n0', parentLocalId: null, type: 'Requirement', title: 'T', description: 'D',
              action: 'create', existingAdoId: null, sourceHash: 'h0', customerId: null,
              sourceRef: { documentPath: '/tmp/doc.docx', startOffset: 10, endOffset: 20, page: null },
              tags: [],
            },
          ],
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      auditEntry: { create: jest.fn().mockResolvedValue(undefined) },

      createdItemMapping: { findMany: jest.fn().mockResolvedValue([]), upsert: jest.fn().mockResolvedValue(undefined), update: jest.fn().mockResolvedValue(undefined) },
    };
    const service = new JobsService(
      prisma as any,
      { createWorkItem, linkParentChild: jest.fn(), discoverFields, discoverWorkItemTypeCategories: jest.fn().mockResolvedValue({ Epic: 'Epic', Feature: 'Feature', Requirement: 'Requirement' }) } as any,
      { record: jest.fn() } as any,
      { upsertDedupEntriesBatch: jest.fn().mockResolvedValue(undefined) } as any,
      'redis://unused',
    );

    await service.confirm('job-1');

    expect(createWorkItem).toHaveBeenCalledWith(
      'Requirement',
      {
        'System.Title': 'T',
        'System.Description': toAdoDescriptionHtml('D'),
        'System.State': 'Proposed',
        'System.AreaPath': 'Project\\Area1',
        'Custom.SourceDocument': '/tmp/doc.docx#offset=10-20',
      },
      undefined,
    );
  });

  it('falls back to stamping SourceRef into System.Tags when no candidate source-ref field is discovered, rather than dropping traceability', async () => {
    const createWorkItem = jest.fn().mockResolvedValue({ id: 203 });
    const discoverFields = jest.fn().mockResolvedValue(['System.Title', 'System.Description']);
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1', status: 'diff_ready', state: 'Proposed', areaPath: 'Project\\Area1',
          dryRunDiff: [
            {
              localId: 'n0', parentLocalId: null, type: 'Requirement', title: 'T', description: 'D',
              action: 'create', existingAdoId: null, sourceHash: 'h0', customerId: null,
              sourceRef: { documentPath: '/tmp/doc.docx', startOffset: 10, endOffset: 20, page: null },
              tags: [],
            },
          ],
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      auditEntry: { create: jest.fn().mockResolvedValue(undefined) },

      createdItemMapping: { findMany: jest.fn().mockResolvedValue([]), upsert: jest.fn().mockResolvedValue(undefined), update: jest.fn().mockResolvedValue(undefined) },
    };
    const service = new JobsService(
      prisma as any,
      { createWorkItem, linkParentChild: jest.fn(), discoverFields, discoverWorkItemTypeCategories: jest.fn().mockResolvedValue({ Epic: 'Epic', Feature: 'Feature', Requirement: 'Requirement' }) } as any,
      { record: jest.fn() } as any,
      { upsertDedupEntriesBatch: jest.fn().mockResolvedValue(undefined) } as any,
      'redis://unused',
    );

    await service.confirm('job-1');

    expect(createWorkItem).toHaveBeenCalledWith(
      'Requirement',
      {
        'System.Title': 'T',
        'System.Description': toAdoDescriptionHtml('D'),
        'System.State': 'Proposed',
        'System.AreaPath': 'Project\\Area1',
        'System.Tags': 'SourceRef:/tmp/doc.docx#offset=10-20',
      },
      undefined,
    );
  });

  it('combines the CustomerId fallback tag with the SourceRef fallback tag when neither custom field resolves', async () => {
    const createWorkItem = jest.fn().mockResolvedValue({ id: 204 });
    const discoverFields = jest.fn().mockResolvedValue(['System.Title', 'System.Description']);
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1', status: 'diff_ready', state: 'Proposed', areaPath: 'Project\\Area1',
          dryRunDiff: [
            {
              localId: 'n0', parentLocalId: null, type: 'Requirement', title: 'T', description: 'D',
              action: 'create', existingAdoId: null, sourceHash: 'h0', customerId: 'CUST-1',
              sourceRef: { documentPath: '/tmp/doc.docx', startOffset: 10, endOffset: 20, page: null },
              tags: ['functional'],
            },
          ],
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      auditEntry: { create: jest.fn().mockResolvedValue(undefined) },

      createdItemMapping: { findMany: jest.fn().mockResolvedValue([]), upsert: jest.fn().mockResolvedValue(undefined), update: jest.fn().mockResolvedValue(undefined) },
    };
    const service = new JobsService(
      prisma as any,
      { createWorkItem, linkParentChild: jest.fn(), discoverFields, discoverWorkItemTypeCategories: jest.fn().mockResolvedValue({ Epic: 'Epic', Feature: 'Feature', Requirement: 'Requirement' }) } as any,
      { record: jest.fn() } as any,
      { upsertDedupEntriesBatch: jest.fn().mockResolvedValue(undefined) } as any,
      'redis://unused',
    );

    await service.confirm('job-1');

    expect(createWorkItem.mock.calls[0][1]['System.Tags']).toBe(
      'functional; CustomerId:CUST-1; SourceRef:/tmp/doc.docx#offset=10-20',
    );
  });

  it('formats a sourceRef with a page number as #page=N&offset=start-end', async () => {
    const createWorkItem = jest.fn().mockResolvedValue({ id: 204 });
    const discoverFields = jest.fn().mockResolvedValue(['Custom.SourceDocument']);
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1', status: 'diff_ready', state: 'Proposed', areaPath: 'Project\\Area1',
          dryRunDiff: [
            {
              localId: 'n0', parentLocalId: null, type: 'Requirement', title: 'T', description: 'D',
              action: 'create', existingAdoId: null, sourceHash: 'h0', customerId: null,
              sourceRef: { documentPath: '/tmp/doc.pdf', startOffset: 5, endOffset: 15, page: 3 },
              tags: [],
            },
          ],
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      auditEntry: { create: jest.fn().mockResolvedValue(undefined) },

      createdItemMapping: { findMany: jest.fn().mockResolvedValue([]), upsert: jest.fn().mockResolvedValue(undefined), update: jest.fn().mockResolvedValue(undefined) },
    };
    const service = new JobsService(
      prisma as any,
      { createWorkItem, linkParentChild: jest.fn(), discoverFields, discoverWorkItemTypeCategories: jest.fn().mockResolvedValue({ Epic: 'Epic', Feature: 'Feature', Requirement: 'Requirement' }) } as any,
      { record: jest.fn() } as any,
      { upsertDedupEntriesBatch: jest.fn().mockResolvedValue(undefined) } as any,
      'redis://unused',
    );

    await service.confirm('job-1');

    expect(createWorkItem.mock.calls[0][1]['Custom.SourceDocument']).toBe('/tmp/doc.pdf#page=3&offset=5-15');
  });

  it('writes non-empty tags as a semicolon-joined System.Tags value', async () => {
    const createWorkItem = jest.fn().mockResolvedValue({ id: 205 });
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1', status: 'diff_ready', state: 'Proposed', areaPath: 'Project\\Area1',
          dryRunDiff: [
            {
              localId: 'n0', parentLocalId: null, type: 'Requirement', title: 'T', description: 'D',
              action: 'create', existingAdoId: null, sourceHash: 'h0', customerId: null,
              sourceRef: null, tags: ['functional', 'safety'],
            },
          ],
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      auditEntry: { create: jest.fn().mockResolvedValue(undefined) },

      createdItemMapping: { findMany: jest.fn().mockResolvedValue([]), upsert: jest.fn().mockResolvedValue(undefined), update: jest.fn().mockResolvedValue(undefined) },
    };
    const service = new JobsService(
      prisma as any,
      { createWorkItem, linkParentChild: jest.fn(), discoverWorkItemTypeCategories: jest.fn().mockResolvedValue({ Epic: 'Epic', Feature: 'Feature', Requirement: 'Requirement' }) } as any,
      { record: jest.fn() } as any,
      { upsertDedupEntriesBatch: jest.fn().mockResolvedValue(undefined) } as any,
      'redis://unused',
    );

    await service.confirm('job-1');

    expect(createWorkItem.mock.calls[0][1]['System.Tags']).toBe('functional; safety');
  });

  it('leaves System.Tags off the written item when the node has no tags', async () => {
    const createWorkItem = jest.fn().mockResolvedValue({ id: 206 });
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1', status: 'diff_ready', state: 'Proposed', areaPath: 'Project\\Area1',
          dryRunDiff: [
            {
              localId: 'n0', parentLocalId: null, type: 'Requirement', title: 'T', description: 'D',
              action: 'create', existingAdoId: null, sourceHash: 'h0', customerId: null,
              sourceRef: null, tags: [],
            },
          ],
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      auditEntry: { create: jest.fn().mockResolvedValue(undefined) },

      createdItemMapping: { findMany: jest.fn().mockResolvedValue([]), upsert: jest.fn().mockResolvedValue(undefined), update: jest.fn().mockResolvedValue(undefined) },
    };
    const service = new JobsService(
      prisma as any,
      { createWorkItem, linkParentChild: jest.fn(), discoverWorkItemTypeCategories: jest.fn().mockResolvedValue({ Epic: 'Epic', Feature: 'Feature', Requirement: 'Requirement' }) } as any,
      { record: jest.fn() } as any,
      { upsertDedupEntriesBatch: jest.fn().mockResolvedValue(undefined) } as any,
      'redis://unused',
    );

    await service.confirm('job-1');

    expect(createWorkItem.mock.calls[0][1]).not.toHaveProperty('System.Tags');
  });

  it('skips creating a dedup_skip node and does not re-parent its matched existing item', async () => {
    const createWorkItem = jest.fn().mockResolvedValueOnce({ id: 300 }); // only the new child gets created
    const linkParentChild = jest.fn().mockResolvedValue(undefined);
    const upsertDedupEntriesBatch = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1', status: 'diff_ready', state: 'Proposed', areaPath: 'Project\\Area1',
          dryRunDiff: [
            // A probable duplicate of an existing ADO item — must be skipped like 'reuse',
            // but its match is NOT a certainty, so it must never be re-parented.
            { localId: 'n0', parentLocalId: null, type: 'Feature', title: 'Parent', description: 'd0', action: 'dedup_skip', existingAdoId: 42, similarity: 0.95, sourceHash: 'h0', customerId: null, sourceRef: null, tags: [] },
            { localId: 'n1', parentLocalId: 'n0', type: 'Requirement', title: 'Child', description: 'd1', action: 'create', existingAdoId: null, similarity: null, sourceHash: 'h1', customerId: null, sourceRef: null, tags: [] },
          ],
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      auditEntry: { create: jest.fn().mockResolvedValue(undefined) },

      createdItemMapping: { findMany: jest.fn().mockResolvedValue([]), upsert: jest.fn().mockResolvedValue(undefined), update: jest.fn().mockResolvedValue(undefined) },
    };
    const service = new JobsService(
      prisma as any,
      { createWorkItem, linkParentChild, discoverWorkItemTypeCategories: jest.fn().mockResolvedValue({ Epic: 'Epic', Feature: 'Feature', Requirement: 'Requirement' }) } as any,
      { record: jest.fn() } as any,
      { upsertDedupEntriesBatch } as any,
      'redis://unused',
    );

    const result = await service.confirm('job-1');

    expect(result).toEqual({ status: 'succeeded', createdCount: 1 });
    expect(createWorkItem).toHaveBeenCalledTimes(1); // n0 (dedup_skip) never creates
    // n1 (a real 'create' node) links UP to n0's matched real ADO id fine —
    // only n0 acting as a CHILD of something else would be suppressed, and
    // n0 has no parent here so that guard isn't exercised by this case.
    expect(linkParentChild).toHaveBeenCalledWith(300, 42, undefined);
  });

  it('does not re-parent an existing item matched by dedup_skip when IT is the child', async () => {
    const createWorkItem = jest.fn().mockResolvedValueOnce({ id: 100 }); // only the new parent gets created
    const linkParentChild = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1', status: 'diff_ready', state: 'Proposed', areaPath: 'Project\\Area1',
          dryRunDiff: [
            { localId: 'n0', parentLocalId: null, type: 'Feature', title: 'Parent', description: 'd0', action: 'create', existingAdoId: null, similarity: null, sourceHash: 'h0', customerId: null, sourceRef: null, tags: [] },
            // A probable duplicate that would otherwise be re-parented under the new n0 —
            // must NOT happen, since its match is a similarity guess, not a certainty.
            { localId: 'n1', parentLocalId: 'n0', type: 'Requirement', title: 'Child', description: 'd1', action: 'dedup_skip', existingAdoId: 42, similarity: 0.95, sourceHash: 'h1', customerId: null, sourceRef: null, tags: [] },
          ],
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      auditEntry: { create: jest.fn().mockResolvedValue(undefined) },

      createdItemMapping: { findMany: jest.fn().mockResolvedValue([]), upsert: jest.fn().mockResolvedValue(undefined), update: jest.fn().mockResolvedValue(undefined) },
    };
    const service = new JobsService(
      prisma as any,
      { createWorkItem, linkParentChild, discoverWorkItemTypeCategories: jest.fn().mockResolvedValue({ Epic: 'Epic', Feature: 'Feature', Requirement: 'Requirement' }) } as any,
      { record: jest.fn() } as any,
      { upsertDedupEntriesBatch: jest.fn().mockResolvedValue(undefined) } as any,
      'redis://unused',
    );

    await service.confirm('job-1');

    expect(linkParentChild).not.toHaveBeenCalled();
  });

  it('does not re-link a reuse-matched item that IS the child -- it already has a Parent relation from its original creation', async () => {
    // Regression: confirmed live (TF401349 from real ADO) -- a 'reuse'
    // (exact-hash, certain) match is an item that already exists in ADO
    // from a prior job, with its own already-established Parent relation.
    // Re-adding that same relation on a later confirm (e.g. resubmitting
    // the same document) violates ADO's one-Parent-per-item rule and 400s
    // with a generic, non-obvious error. Same suppression as dedup_skip's
    // child case, for a different (certain, not probabilistic) reason.
    const createWorkItem = jest.fn().mockResolvedValueOnce({ id: 100 }); // only the new parent gets created
    const linkParentChild = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1', status: 'diff_ready', state: 'Proposed', areaPath: 'Project\\Area1',
          dryRunDiff: [
            { localId: 'n0', parentLocalId: null, type: 'Feature', title: 'Parent', description: 'd0', action: 'create', existingAdoId: null, similarity: null, sourceHash: 'h0', customerId: null, sourceRef: null, tags: [] },
            // An exact-hash match to an item already created (and already
            // parented) in a prior job -- must NOT be re-linked here.
            { localId: 'n1', parentLocalId: 'n0', type: 'Requirement', title: 'Child', description: 'd1', action: 'reuse', existingAdoId: 42, similarity: null, sourceHash: 'h1', customerId: null, sourceRef: null, tags: [] },
          ],
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      auditEntry: { create: jest.fn().mockResolvedValue(undefined) },

      createdItemMapping: { findMany: jest.fn().mockResolvedValue([]), upsert: jest.fn().mockResolvedValue(undefined), update: jest.fn().mockResolvedValue(undefined) },
    };
    const service = new JobsService(
      prisma as any,
      { createWorkItem, linkParentChild, discoverWorkItemTypeCategories: jest.fn().mockResolvedValue({ Epic: 'Epic', Feature: 'Feature', Requirement: 'Requirement' }) } as any,
      { record: jest.fn() } as any,
      { upsertDedupEntriesBatch: jest.fn().mockResolvedValue(undefined) } as any,
      'redis://unused',
    );

    await service.confirm('job-1');

    expect(linkParentChild).not.toHaveBeenCalled();
  });

  it('batches a dedup upsert for every newly-created item, but not for reused/dedup_skip ones', async () => {
    // Regression: confirm() previously called upsertDedupEntry once per
    // newly-created node inline in the loop (one embed() round-trip each);
    // now collects all of them and calls upsertDedupEntriesBatch ONCE.
    const createWorkItem = jest.fn()
      .mockResolvedValueOnce({ id: 500 })
      .mockResolvedValueOnce({ id: 501 });
    const upsertDedupEntriesBatch = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1', status: 'diff_ready', state: 'Proposed', areaPath: 'Project\\Area1',
          dryRunDiff: [
            { localId: 'n0', parentLocalId: null, type: 'Requirement', title: 'T', description: 'D', action: 'create', existingAdoId: null, similarity: null, sourceHash: 'h0', customerId: null, sourceRef: null, tags: [] },
            { localId: 'n1', parentLocalId: null, type: 'Requirement', title: 'T2', description: 'D2', action: 'create', existingAdoId: null, similarity: null, sourceHash: 'h1', customerId: null, sourceRef: null, tags: [] },
          ],
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      auditEntry: { create: jest.fn().mockResolvedValue(undefined) },

      createdItemMapping: { findMany: jest.fn().mockResolvedValue([]), upsert: jest.fn().mockResolvedValue(undefined), update: jest.fn().mockResolvedValue(undefined) },
    };
    const service = new JobsService(
      prisma as any,
      { createWorkItem, linkParentChild: jest.fn(), discoverWorkItemTypeCategories: jest.fn().mockResolvedValue({ Epic: 'Epic', Feature: 'Feature', Requirement: 'Requirement' }) } as any,
      { record: jest.fn() } as any,
      { upsertDedupEntriesBatch } as any,
      'redis://unused',
    );

    await service.confirm('job-1');

    expect(upsertDedupEntriesBatch).toHaveBeenCalledTimes(1);
    expect(upsertDedupEntriesBatch).toHaveBeenCalledWith([
      { itemId: '500', text: 'D', title: 'T', areaPath: 'Project\\Area1' },
      { itemId: '501', text: 'D2', title: 'T2', areaPath: 'Project\\Area1' },
    ]);
  });

  it('writes a configured initial state instead of the hardcoded "Proposed" default', async () => {
    // Regression: System.State was previously hardcoded literal 'Proposed'
    // in the create-fields object -- an on-prem custom process template
    // without that exact state would fail every create. System.State is now
    // sourced from job.state (populated at submit() time from either the
    // caller's explicit state or JobsService's initialState ctor default),
    // not re-read from the ctor here -- so this fixture sets job.state
    // directly to prove confirm() honors a non-default value.
    const createWorkItem = jest.fn().mockResolvedValue({ id: 300 });
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1', status: 'diff_ready', state: 'New', areaPath: 'Project\\Area1',
          dryRunDiff: [
            { localId: 'n0', parentLocalId: null, type: 'Requirement', title: 'T', description: 'D', action: 'create', existingAdoId: null, sourceHash: 'h0', customerId: null, sourceRef: null, tags: [] },
          ],
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      auditEntry: { create: jest.fn().mockResolvedValue(undefined) },

      createdItemMapping: { findMany: jest.fn().mockResolvedValue([]), upsert: jest.fn().mockResolvedValue(undefined), update: jest.fn().mockResolvedValue(undefined) },
    };
    const service = new JobsService(
      prisma as any,
      { createWorkItem, linkParentChild: jest.fn(), discoverWorkItemTypeCategories: jest.fn().mockResolvedValue({ Epic: 'Epic', Feature: 'Feature', Requirement: 'Requirement' }) } as any,
      { record: jest.fn() } as any,
      { upsertDedupEntriesBatch: jest.fn().mockResolvedValue(undefined) } as any,
      'redis://unused',
    );

    await service.confirm('job-1');

    expect(createWorkItem).toHaveBeenCalledWith(
      'Requirement',
      expect.objectContaining({ 'System.State': 'New' }),
      undefined,
    );
  });

  it('does not fail confirm() when the dedup upsert itself fails (best-effort, not a required write)', async () => {
    const createWorkItem = jest.fn().mockResolvedValue({ id: 501 });
    const upsertDedupEntriesBatch = jest.fn().mockRejectedValue(new Error('ingestion unreachable'));
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1', status: 'diff_ready', state: 'Proposed', areaPath: 'Project\\Area1',
          dryRunDiff: [
            { localId: 'n0', parentLocalId: null, type: 'Requirement', title: 'T', description: 'D', action: 'create', existingAdoId: null, similarity: null, sourceHash: 'h0', customerId: null, sourceRef: null, tags: [] },
          ],
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      auditEntry: { create: jest.fn().mockResolvedValue(undefined) },

      createdItemMapping: { findMany: jest.fn().mockResolvedValue([]), upsert: jest.fn().mockResolvedValue(undefined), update: jest.fn().mockResolvedValue(undefined) },
    };
    const service = new JobsService(
      prisma as any,
      { createWorkItem, linkParentChild: jest.fn(), discoverWorkItemTypeCategories: jest.fn().mockResolvedValue({ Epic: 'Epic', Feature: 'Feature', Requirement: 'Requirement' }) } as any,
      { record: jest.fn() } as any,
      { upsertDedupEntriesBatch } as any,
      'redis://unused',
    );

    const result = await service.confirm('job-1');

    expect(result).toEqual({ status: 'succeeded', createdCount: 1 });
  });

  it('reverts to diff_ready (not stuck in writing) when createWorkItem fails before anything was created', async () => {
    // Regression: confirm() previously set status='writing' with no
    // try/catch -- a mid-write failure left the job stuck there forever,
    // since confirm()'s own guard requires status==='diff_ready'. Found live
    // against a real ADO org: the first createWorkItem call failed (bad
    // api-version resolution) and the job could never be retried again.
    const createWorkItem = jest.fn().mockRejectedValue(new Error('ADO connectionData validation failed: 401'));
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1', status: 'diff_ready', state: 'Proposed', areaPath: 'Project\\Area1',
          dryRunDiff: [
            { localId: 'n0', parentLocalId: null, type: 'Requirement', title: 'T', description: 'D', action: 'create', existingAdoId: null, similarity: null, sourceHash: 'h0', customerId: null, sourceRef: null, tags: [] },
          ],
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      auditEntry: { create: jest.fn().mockResolvedValue(undefined) },

      createdItemMapping: { findMany: jest.fn().mockResolvedValue([]), upsert: jest.fn().mockResolvedValue(undefined), update: jest.fn().mockResolvedValue(undefined) },
    };
    const service = new JobsService(
      prisma as any,
      { createWorkItem, linkParentChild: jest.fn(), discoverWorkItemTypeCategories: jest.fn().mockResolvedValue({ Epic: 'Epic', Feature: 'Feature', Requirement: 'Requirement' }) } as any,
      { record: jest.fn() } as any,
      { upsertDedupEntriesBatch: jest.fn() } as any,
      'redis://unused',
    );

    await expect(service.confirm('job-1')).rejects.toThrow('ADO connectionData validation failed: 401');

    expect(prisma.job.update).toHaveBeenCalledWith({ where: { id: 'job-1' }, data: { status: 'diff_ready' } });
    expect(prisma.auditEntry.create).toHaveBeenCalledWith({
      data: { jobId: 'job-1', message: 'Confirm failed (safe to retry): ADO connectionData validation failed: 401' },
    });
  });

  it('reverts to diff_ready (not failed) even when the write fails after some items were already created, now that P4b resume state exists', async () => {
    // P4b built: CreatedItemMapping durably records the first item's create
    // before the second one fails, so a retry will skip re-creating it (see
    // the 'JobsService.confirm resume (P4b)' describe block below for the
    // dedicated resume-behavior tests) -- reverting to diff_ready is now
    // always safe, not just when createdCount was 0.
    const createWorkItem = jest.fn()
      .mockResolvedValueOnce({ id: 100 })
      .mockRejectedValueOnce(new Error('ADO unreachable'));
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1', status: 'diff_ready', state: 'Proposed', areaPath: 'Project\\Area1',
          dryRunDiff: [
            { localId: 'n0', parentLocalId: null, type: 'Feature', title: 'A', description: 'dA', action: 'create', existingAdoId: null, sourceHash: 'h0', customerId: null, sourceRef: null, tags: [] },
            { localId: 'n1', parentLocalId: null, type: 'Feature', title: 'B', description: 'dB', action: 'create', existingAdoId: null, sourceHash: 'h1', customerId: null, sourceRef: null, tags: [] },
          ],
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      auditEntry: { create: jest.fn().mockResolvedValue(undefined) },

      createdItemMapping: { findMany: jest.fn().mockResolvedValue([]), upsert: jest.fn().mockResolvedValue(undefined), update: jest.fn().mockResolvedValue(undefined) },
    };
    const service = new JobsService(
      prisma as any,
      { createWorkItem, linkParentChild: jest.fn(), discoverWorkItemTypeCategories: jest.fn().mockResolvedValue({ Epic: 'Epic', Feature: 'Feature', Requirement: 'Requirement' }) } as any,
      { record: jest.fn().mockResolvedValue(undefined) } as any,
      { upsertDedupEntriesBatch: jest.fn().mockResolvedValue(undefined) } as any,
      'redis://unused',
    );

    await expect(service.confirm('job-1')).rejects.toThrow('ADO unreachable');

    expect(prisma.job.update).toHaveBeenCalledWith({ where: { id: 'job-1' }, data: { status: 'diff_ready' } });
  });
});

describe('JobsService.confirm resume (P4b)', () => {
  it('writes a CreatedItemMapping row immediately after each successful create', async () => {
    const createWorkItem = jest.fn().mockResolvedValue({ id: 100 });
    const upsert = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1', status: 'diff_ready', state: 'Proposed', areaPath: 'Project\\Area1',
          dryRunDiff: [
            { localId: 'n0', parentLocalId: null, type: 'Requirement', title: 'T', description: 'D', action: 'create', existingAdoId: null, sourceHash: 'h0', customerId: null, sourceRef: null, tags: [] },
          ],
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      auditEntry: { create: jest.fn().mockResolvedValue(undefined) },
      createdItemMapping: { findMany: jest.fn().mockResolvedValue([]), upsert, update: jest.fn().mockResolvedValue(undefined) },
    };
    const service = new JobsService(
      prisma as any,
      { createWorkItem, linkParentChild: jest.fn(), discoverWorkItemTypeCategories: jest.fn().mockResolvedValue({ Epic: 'Epic', Feature: 'Feature', Requirement: 'Requirement' }) } as any,
      { record: jest.fn().mockResolvedValue(undefined) } as any,
      { upsertDedupEntriesBatch: jest.fn().mockResolvedValue(undefined) } as any,
      'redis://unused',
    );

    await service.confirm('job-1');

    expect(upsert).toHaveBeenCalledWith({
      where: { jobId_localId: { jobId: 'job-1', localId: 'n0' } },
      create: { jobId: 'job-1', localId: 'n0', adoWorkItemId: 100 },
      update: { adoWorkItemId: 100 },
    });
  });

  it('skips re-creating a localId that already has a CreatedItemMapping row from a prior attempt', async () => {
    const createWorkItem = jest.fn().mockResolvedValue({ id: 999 });
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1', status: 'diff_ready', state: 'Proposed', areaPath: 'Project\\Area1',
          dryRunDiff: [
            { localId: 'n0', parentLocalId: null, type: 'Feature', title: 'A', description: 'dA', action: 'create', existingAdoId: null, sourceHash: 'h0', customerId: null, sourceRef: null, tags: [] },
            { localId: 'n1', parentLocalId: 'n0', type: 'Requirement', title: 'B', description: 'dB', action: 'create', existingAdoId: null, sourceHash: 'h1', customerId: null, sourceRef: null, tags: [] },
          ],
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      auditEntry: { create: jest.fn().mockResolvedValue(undefined) },
      createdItemMapping: {
        findMany: jest.fn().mockResolvedValue([{ localId: 'n0', adoWorkItemId: 100, linked: false }]),
        upsert: jest.fn().mockResolvedValue(undefined),
        update: jest.fn().mockResolvedValue(undefined),
      },
    };
    const service = new JobsService(
      prisma as any,
      { createWorkItem, linkParentChild: jest.fn(), discoverWorkItemTypeCategories: jest.fn().mockResolvedValue({ Epic: 'Epic', Feature: 'Feature', Requirement: 'Requirement' }) } as any,
      { record: jest.fn().mockResolvedValue(undefined) } as any,
      { upsertDedupEntriesBatch: jest.fn().mockResolvedValue(undefined) } as any,
      'redis://unused',
    );

    const result = await service.confirm('job-1');

    // Only 'n1' gets created this call -- 'n0' was resumed from the prior
    // attempt's mapping, not re-created.
    expect(createWorkItem).toHaveBeenCalledTimes(1);
    expect(createWorkItem).toHaveBeenCalledWith('Requirement', expect.objectContaining({ 'System.Title': 'B' }), undefined);
    expect(result).toEqual({ status: 'succeeded', createdCount: 1 });
  });

  it('links a resumed parent to a newly-created child using the resumed ADO id', async () => {
    const createWorkItem = jest.fn().mockResolvedValue({ id: 200 });
    const linkParentChild = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1', status: 'diff_ready', state: 'Proposed', areaPath: 'Project\\Area1',
          dryRunDiff: [
            { localId: 'n0', parentLocalId: null, type: 'Feature', title: 'A', description: 'dA', action: 'create', existingAdoId: null, sourceHash: 'h0', customerId: null, sourceRef: null, tags: [] },
            { localId: 'n1', parentLocalId: 'n0', type: 'Requirement', title: 'B', description: 'dB', action: 'create', existingAdoId: null, sourceHash: 'h1', customerId: null, sourceRef: null, tags: [] },
          ],
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      auditEntry: { create: jest.fn().mockResolvedValue(undefined) },
      createdItemMapping: {
        findMany: jest.fn().mockResolvedValue([{ localId: 'n0', adoWorkItemId: 500, linked: false }]),
        upsert: jest.fn().mockResolvedValue(undefined),
        update: jest.fn().mockResolvedValue(undefined),
      },
    };
    const service = new JobsService(
      prisma as any,
      { createWorkItem, linkParentChild, discoverWorkItemTypeCategories: jest.fn().mockResolvedValue({ Epic: 'Epic', Feature: 'Feature', Requirement: 'Requirement' }) } as any,
      { record: jest.fn().mockResolvedValue(undefined) } as any,
      { upsertDedupEntriesBatch: jest.fn().mockResolvedValue(undefined) } as any,
      'redis://unused',
    );

    await service.confirm('job-1');

    expect(linkParentChild).toHaveBeenCalledWith(200, 500, undefined);
  });

  it('does not re-link a localId already marked linked=true from a prior attempt', async () => {
    const createWorkItem = jest.fn();
    const linkParentChild = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1', status: 'diff_ready', state: 'Proposed', areaPath: 'Project\\Area1',
          dryRunDiff: [
            { localId: 'n0', parentLocalId: null, type: 'Feature', title: 'A', description: 'dA', action: 'create', existingAdoId: null, sourceHash: 'h0', customerId: null, sourceRef: null, tags: [] },
            { localId: 'n1', parentLocalId: 'n0', type: 'Requirement', title: 'B', description: 'dB', action: 'create', existingAdoId: null, sourceHash: 'h1', customerId: null, sourceRef: null, tags: [] },
          ],
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      auditEntry: { create: jest.fn().mockResolvedValue(undefined) },
      createdItemMapping: {
        findMany: jest.fn().mockResolvedValue([
          { localId: 'n0', adoWorkItemId: 500, linked: true },
          { localId: 'n1', adoWorkItemId: 600, linked: true },
        ]),
        upsert: jest.fn().mockResolvedValue(undefined),
        update: jest.fn().mockResolvedValue(undefined),
      },
    };
    const service = new JobsService(
      prisma as any,
      { createWorkItem, linkParentChild, discoverWorkItemTypeCategories: jest.fn().mockResolvedValue({ Epic: 'Epic', Feature: 'Feature', Requirement: 'Requirement' }) } as any,
      { record: jest.fn().mockResolvedValue(undefined) } as any,
      { upsertDedupEntriesBatch: jest.fn().mockResolvedValue(undefined) } as any,
      'redis://unused',
    );

    const result = await service.confirm('job-1');

    expect(createWorkItem).not.toHaveBeenCalled();
    expect(linkParentChild).not.toHaveBeenCalled();
    expect(result).toEqual({ status: 'succeeded', createdCount: 0 });
  });

  it('marks a CreatedItemMapping row linked=true immediately after a successful link', async () => {
    const createWorkItem = jest.fn()
      .mockResolvedValueOnce({ id: 100 }) // parent
      .mockResolvedValueOnce({ id: 101 }); // child
    const update = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1', status: 'diff_ready', state: 'Proposed', areaPath: 'Project\\Area1',
          dryRunDiff: [
            { localId: 'n0', parentLocalId: null, type: 'Feature', title: 'Parent', description: 'd0', action: 'create', existingAdoId: null, sourceHash: 'h0', customerId: null, sourceRef: null, tags: [] },
            { localId: 'n1', parentLocalId: 'n0', type: 'Requirement', title: 'Child', description: 'd1', action: 'create', existingAdoId: null, sourceHash: 'h1', customerId: null, sourceRef: null, tags: [] },
          ],
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      auditEntry: { create: jest.fn().mockResolvedValue(undefined) },
      createdItemMapping: { findMany: jest.fn().mockResolvedValue([]), upsert: jest.fn().mockResolvedValue(undefined), update },
    };
    const service = new JobsService(
      prisma as any,
      { createWorkItem, linkParentChild: jest.fn().mockResolvedValue(undefined), discoverWorkItemTypeCategories: jest.fn().mockResolvedValue({ Epic: 'Epic', Feature: 'Feature', Requirement: 'Requirement' }) } as any,
      { record: jest.fn().mockResolvedValue(undefined) } as any,
      { upsertDedupEntriesBatch: jest.fn().mockResolvedValue(undefined) } as any,
      'redis://unused',
    );

    await service.confirm('job-1');

    expect(update).toHaveBeenCalledWith({
      where: { jobId_localId: { jobId: 'job-1', localId: 'n1' } },
      data: { linked: true },
    });
  });
});

describe('JobsService.confirm — row deselect', () => {
  it('only creates entries whose localId is in selectedLocalIds, when provided', async () => {
    const createWorkItem = jest.fn().mockResolvedValue({ id: 500 });
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1', status: 'diff_ready', state: 'Proposed', areaPath: 'Project\\Area1',
          dryRunDiff: [
            { localId: 'n0', parentLocalId: null, type: 'Requirement', title: 'A', description: 'dA', action: 'create', existingAdoId: null, sourceHash: 'h0', customerId: null, sourceRef: null, tags: [] },
            { localId: 'n1', parentLocalId: null, type: 'Requirement', title: 'B', description: 'dB', action: 'create', existingAdoId: null, sourceHash: 'h1', customerId: null, sourceRef: null, tags: [] },
          ],
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      auditEntry: { create: jest.fn().mockResolvedValue(undefined) },

      createdItemMapping: { findMany: jest.fn().mockResolvedValue([]), upsert: jest.fn().mockResolvedValue(undefined), update: jest.fn().mockResolvedValue(undefined) },
    };
    const service = new JobsService(
      prisma as any,
      { createWorkItem, linkParentChild: jest.fn(), discoverWorkItemTypeCategories: jest.fn().mockResolvedValue({ Epic: 'Epic', Feature: 'Feature', Requirement: 'Requirement' }) } as any,
      { record: jest.fn() } as any,
      { upsertDedupEntriesBatch: jest.fn().mockResolvedValue(undefined) } as any,
      'redis://unused',
    );

    const result = await service.confirm('job-1', undefined, ['n0']);

    expect(result).toEqual({ status: 'succeeded', createdCount: 1 });
    expect(createWorkItem).toHaveBeenCalledTimes(1);
    expect(createWorkItem).toHaveBeenCalledWith('Requirement', expect.objectContaining({ 'System.Title': 'A' }), undefined);
  });

  it('does not link a child to a parent that was deselected (parent never gets an ADO id)', async () => {
    const createWorkItem = jest.fn().mockResolvedValue({ id: 501 });
    const linkParentChild = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1', status: 'diff_ready', state: 'Proposed', areaPath: 'Project\\Area1',
          dryRunDiff: [
            { localId: 'n0', parentLocalId: null, type: 'Feature', title: 'Parent', description: 'd0', action: 'create', existingAdoId: null, sourceHash: 'h0', customerId: null, sourceRef: null, tags: [] },
            { localId: 'n1', parentLocalId: 'n0', type: 'Requirement', title: 'Child', description: 'd1', action: 'create', existingAdoId: null, sourceHash: 'h1', customerId: null, sourceRef: null, tags: [] },
          ],
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      auditEntry: { create: jest.fn().mockResolvedValue(undefined) },

      createdItemMapping: { findMany: jest.fn().mockResolvedValue([]), upsert: jest.fn().mockResolvedValue(undefined), update: jest.fn().mockResolvedValue(undefined) },
    };
    const service = new JobsService(
      prisma as any,
      { createWorkItem, linkParentChild, discoverWorkItemTypeCategories: jest.fn().mockResolvedValue({ Epic: 'Epic', Feature: 'Feature', Requirement: 'Requirement' }) } as any,
      { record: jest.fn() } as any,
      { upsertDedupEntriesBatch: jest.fn().mockResolvedValue(undefined) } as any,
      'redis://unused',
    );

    const result = await service.confirm('job-1', undefined, ['n1']);

    expect(result).toEqual({ status: 'succeeded', createdCount: 1 });
    expect(linkParentChild).not.toHaveBeenCalled();
  });

  it('selects every create entry when selectedLocalIds is omitted (backward-compatible default)', async () => {
    const createWorkItem = jest.fn().mockResolvedValue({ id: 502 });
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1', status: 'diff_ready', state: 'Proposed', areaPath: 'Project\\Area1',
          dryRunDiff: [
            { localId: 'n0', parentLocalId: null, type: 'Requirement', title: 'A', description: 'dA', action: 'create', existingAdoId: null, sourceHash: 'h0', customerId: null, sourceRef: null, tags: [] },
            { localId: 'n1', parentLocalId: null, type: 'Requirement', title: 'B', description: 'dB', action: 'create', existingAdoId: null, sourceHash: 'h1', customerId: null, sourceRef: null, tags: [] },
          ],
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      auditEntry: { create: jest.fn().mockResolvedValue(undefined) },

      createdItemMapping: { findMany: jest.fn().mockResolvedValue([]), upsert: jest.fn().mockResolvedValue(undefined), update: jest.fn().mockResolvedValue(undefined) },
    };
    const service = new JobsService(
      prisma as any,
      { createWorkItem, linkParentChild: jest.fn(), discoverWorkItemTypeCategories: jest.fn().mockResolvedValue({ Epic: 'Epic', Feature: 'Feature', Requirement: 'Requirement' }) } as any,
      { record: jest.fn() } as any,
      { upsertDedupEntriesBatch: jest.fn().mockResolvedValue(undefined) } as any,
      'redis://unused',
    );

    const result = await service.confirm('job-1');

    expect(result).toEqual({ status: 'succeeded', createdCount: 2 });
  });
});

describe('JobsService.reject', () => {
  it('rejects a diff_ready job and records an audit entry', async () => {
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({ id: 'job-1', status: 'diff_ready' }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      auditEntry: { create: jest.fn().mockResolvedValue(undefined) },

      createdItemMapping: { findMany: jest.fn().mockResolvedValue([]), upsert: jest.fn().mockResolvedValue(undefined), update: jest.fn().mockResolvedValue(undefined) },
    };
    const service = new JobsService(prisma as any, {} as any, {} as any, {} as any, 'redis://unused');

    const result = await service.reject('job-1');

    expect(result).toEqual({ status: 'rejected' });
    expect(prisma.job.update).toHaveBeenCalledWith({ where: { id: 'job-1' }, data: { status: 'rejected' } });
    expect(prisma.auditEntry.create).toHaveBeenCalledWith({
      data: { jobId: 'job-1', message: 'Job rejected: no work items written' },
    });
  });

  it('throws when the job is not in a rejectable state', async () => {
    const prisma = {
      job: { findUnique: jest.fn().mockResolvedValue({ id: 'job-1', status: 'succeeded' }), update: jest.fn() },
      auditEntry: { create: jest.fn() },

      createdItemMapping: { findMany: jest.fn().mockResolvedValue([]), upsert: jest.fn().mockResolvedValue(undefined), update: jest.fn().mockResolvedValue(undefined) },
    };
    const service = new JobsService(prisma as any, {} as any, {} as any, {} as any, 'redis://unused');

    await expect(service.reject('job-1')).rejects.toThrow('is not in a rejectable state');
  });

  it('throws for an unknown job id', async () => {
    const prisma = { job: { findUnique: jest.fn().mockResolvedValue(null), update: jest.fn() }, auditEntry: { create: jest.fn() } };
    const service = new JobsService(prisma as any, {} as any, {} as any, {} as any, 'redis://unused');

    await expect(service.reject('unknown')).rejects.toThrow('is not in a rejectable state');
  });
});

describe('JobsService.getDebugCaptures', () => {
  it('returns whatever the ingestion client returns', async () => {
    const ingestionClient = {
      getDebugCaptures: jest.fn().mockResolvedValue([{ kind: 'infer_trace_links', identifier: 'document', content: 'raw content' }]),
    };
    const service = new JobsService({} as any, {} as any, { record: jest.fn() } as any, ingestionClient as any, 'redis://unused');

    const result = await service.getDebugCaptures('job-1');

    expect(ingestionClient.getDebugCaptures).toHaveBeenCalledWith('job-1');
    expect(result).toEqual([{ kind: 'infer_trace_links', identifier: 'document', content: 'raw content' }]);
  });

  it('returns an empty array when the ingestion client is unreachable, rather than failing the Audit tab', async () => {
    const ingestionClient = { getDebugCaptures: jest.fn().mockRejectedValue(new Error('connection refused')) };
    const service = new JobsService({} as any, {} as any, { record: jest.fn() } as any, ingestionClient as any, 'redis://unused');

    const result = await service.getDebugCaptures('job-1');

    expect(result).toEqual([]);
  });
});

describe('JobsService.getDedupSkips', () => {
  it('returns the durable dedup-skip audit rows for a job, ordered oldest-first', async () => {
    const rows = [
      { id: 'a1', localId: 'n1', similarity: 0.95, existingAdoId: 42, createdAt: new Date('2026-01-01') },
      { id: 'a2', localId: 'n2', similarity: 0.91, existingAdoId: 43, createdAt: new Date('2026-01-02') },
    ];
    const findMany = jest.fn().mockResolvedValue(rows);
    const prisma = { dedupSkipAudit: { findMany } };
    const service = new JobsService(prisma as any, {} as any, {} as any, {} as any, 'redis://unused');

    const result = await service.getDedupSkips('job-1');

    expect(result).toEqual(rows);
    expect(findMany).toHaveBeenCalledWith({ where: { jobId: 'job-1' }, orderBy: { createdAt: 'asc' } });
  });
});

describe('JobsService.getSummary', () => {
  function makeService(job: unknown): JobsService {
    const prisma = { job: { findUnique: jest.fn().mockResolvedValue(job) }, auditEntry: { create: jest.fn() } };
    return new JobsService(
      prisma as any,
      {} as any,
      {} as any,
      {} as any,
      'redis://unused',
    );
  }

  it('aggregates create/reuse/dedup_skip counts and warnings from the stored job (legacy string[] jobs)', async () => {
    const service = makeService({
      id: 'job-1',
      dryRunDiff: [
        { action: 'create', groundingScore: null, qualityScore: null },
        { action: 'create', groundingScore: null, qualityScore: null },
        { action: 'reuse', groundingScore: null, qualityScore: null },
        { action: 'dedup_skip', groundingScore: null, qualityScore: null },
      ],
      warnings: ['SURVEY node count diverges from source block count'],
    });

    const summary = await service.getSummary('job-1');

    expect(summary).toEqual({
      created: 2,
      reused: 1,
      dedupSkipped: 1,
      flagged: 0,
      warnings: ['SURVEY node count diverges from source block count'],
    });
  });

  it('round-trips a structured WarningRecord[] job unchanged (no reclassification at this layer)', async () => {
    const warning = {
      kind: 'reparented_to_feature',
      severity: 'auto_fixed',
      nodeIds: ['n0', 'n1'],
      detail: { targetFeatureId: 'f0' },
      raw: '2 Requirement(s) were re-parented under Feature f0 to keep the Epic -> Feature -> Requirement chain intact.',
    };
    const service = makeService({
      id: 'job-1',
      dryRunDiff: [],
      warnings: [warning],
    });

    const summary = await service.getSummary('job-1');

    expect(summary?.warnings).toEqual([warning]);
  });

  it('counts an entry as flagged when groundingScore is below 0.2 or qualityScore is below 50', async () => {
    const service = makeService({
      id: 'job-1',
      dryRunDiff: [
        { action: 'create', groundingScore: 0.1, qualityScore: null },
        { action: 'create', groundingScore: null, qualityScore: 30 },
        { action: 'create', groundingScore: 0.9, qualityScore: 95 },
      ],
      warnings: [],
    });

    const summary = await service.getSummary('job-1');

    expect(summary?.flagged).toBe(2);
  });

  it('defaults dryRunDiff/warnings to empty when the job has neither yet (still pending/running)', async () => {
    const service = makeService({ id: 'job-1', dryRunDiff: null, warnings: null });

    const summary = await service.getSummary('job-1');

    expect(summary).toEqual({ created: 0, reused: 0, dedupSkipped: 0, flagged: 0, warnings: [] });
  });

  it('returns null for an unknown job id', async () => {
    const service = makeService(null);

    expect(await service.getSummary('unknown')).toBeNull();
  });
});

describe('JobsService.validateCreatedTree', () => {
  function makeService(
    job: unknown,
    mappings: { localId: string; adoWorkItemId: number }[],
    getWorkItemsBatch: jest.Mock,
  ): JobsService {
    const prisma = {
      job: { findUnique: jest.fn().mockResolvedValue(job) },
      createdItemMapping: { findMany: jest.fn().mockResolvedValue(mappings) },
    };
    return new JobsService(prisma as any, { getWorkItemsBatch } as any, {} as any, {} as any, 'redis://unused');
  }

  it('returns valid:true with checkedCount 0 when nothing has been created yet', async () => {
    const getWorkItemsBatch = jest.fn();
    const service = makeService({ id: 'job-1', dryRunDiff: [] }, [], getWorkItemsBatch);

    const result = await service.validateCreatedTree('job-1');

    expect(result).toEqual({ valid: true, checkedCount: 0, mismatches: [] });
    expect(getWorkItemsBatch).not.toHaveBeenCalled();
  });

  it('reports valid:true when every ADO field/parent matches the dry-run diff', async () => {
    const getWorkItemsBatch = jest.fn().mockResolvedValue([
      { id: 100, type: 'Feature', fields: { 'System.Title': 'Parent', 'System.Description': toAdoDescriptionHtml('d0') }, parentId: null },
      { id: 101, type: 'Requirement', fields: { 'System.Title': 'Child', 'System.Description': toAdoDescriptionHtml('d1') }, parentId: 100 },
    ]);
    const service = makeService(
      {
        id: 'job-1',
        dryRunDiff: [
          { localId: 'n0', parentLocalId: null, title: 'Parent', description: 'd0' },
          { localId: 'n1', parentLocalId: 'n0', title: 'Child', description: 'd1' },
        ],
      },
      [
        { localId: 'n0', adoWorkItemId: 100 },
        { localId: 'n1', adoWorkItemId: 101 },
      ],
      getWorkItemsBatch,
    );

    const result = await service.validateCreatedTree('job-1');

    expect(result).toEqual({ valid: true, checkedCount: 2, mismatches: [] });
    expect(getWorkItemsBatch).toHaveBeenCalledWith([100, 101], undefined);
  });

  it('does not false-positive on ADO own write-time HTML re-serialization (confirmed via a real round-trip spike)', async () => {
    // Real captured shape from a live ADO work item (see
    // docs/superpowers/specs/2026-08-12-table-fidelity-design.md's Phase 0
    // findings): ADO unquotes numeric colspan/rowspan, appends a trailing
    // `;` to style values, and adds a trailing space inside leaf text --
    // none of that is a REAL mismatch, and before normalizeAdoStoredHtml
    // this reported one on every single item, table or not.
    const getWorkItemsBatch = jest.fn().mockResolvedValue([
      {
        id: 100, type: 'Requirement',
        fields: {
          'System.Title': 'Table 1',
          'System.Description':
            '<table><thead><tr><th colspan=3 style="text-align:center;">Config</th></tr></thead><tbody><tr><td rowspan=2>GPU </td><td>60 </td><td>3 </td></tr><tr><td>85 </td><td>2 </td></tr></tbody></table>',
        },
        parentId: null,
      },
    ]);
    const service = makeService(
      {
        id: 'job-1',
        dryRunDiff: [
          {
            localId: 'n0', parentLocalId: null, title: 'Table 1',
            description:
              '<table><thead><tr><th colspan="3" style="text-align:center">Config</th></tr></thead><tbody><tr><td rowspan="2">GPU</td><td>60</td><td>3</td></tr><tr><td>85</td><td>2</td></tr></tbody></table>',
          },
        ],
      },
      [{ localId: 'n0', adoWorkItemId: 100 }],
      getWorkItemsBatch,
    );

    const result = await service.validateCreatedTree('job-1');

    expect(result).toEqual({ valid: true, checkedCount: 1, mismatches: [] });
  });

  it('reports a mismatch when the real ADO title differs from the dry-run diff', async () => {
    const getWorkItemsBatch = jest.fn().mockResolvedValue([
      { id: 100, type: 'Requirement', fields: { 'System.Title': 'Truncated Ti', 'System.Description': toAdoDescriptionHtml('d0') }, parentId: null },
    ]);
    const service = makeService(
      { id: 'job-1', dryRunDiff: [{ localId: 'n0', parentLocalId: null, title: 'Truncated Title', description: 'd0' }] },
      [{ localId: 'n0', adoWorkItemId: 100 }],
      getWorkItemsBatch,
    );

    const result = await service.validateCreatedTree('job-1');

    expect(result?.valid).toBe(false);
    expect(result?.mismatches).toEqual([
      { localId: 'n0', adoWorkItemId: 100, field: 'System.Title', expected: 'Truncated Title', actual: 'Truncated Ti' },
    ]);
  });

  it('reports a mismatch when the real ADO parent link differs from the dry-run diff', async () => {
    const getWorkItemsBatch = jest.fn().mockResolvedValue([
      { id: 100, type: 'Feature', fields: { 'System.Title': 'Parent', 'System.Description': toAdoDescriptionHtml('d0') }, parentId: null },
      { id: 101, type: 'Requirement', fields: { 'System.Title': 'Child', 'System.Description': toAdoDescriptionHtml('d1') }, parentId: null },
    ]);
    const service = makeService(
      {
        id: 'job-1',
        dryRunDiff: [
          { localId: 'n0', parentLocalId: null, title: 'Parent', description: 'd0' },
          { localId: 'n1', parentLocalId: 'n0', title: 'Child', description: 'd1' },
        ],
      },
      [
        { localId: 'n0', adoWorkItemId: 100 },
        { localId: 'n1', adoWorkItemId: 101 },
      ],
      getWorkItemsBatch,
    );

    const result = await service.validateCreatedTree('job-1');

    expect(result?.valid).toBe(false);
    expect(result?.mismatches).toEqual([
      { localId: 'n1', adoWorkItemId: 101, field: 'parentId', expected: '100', actual: 'null' },
    ]);
  });

  it('reports an existence mismatch when a mapped work item is missing from ADO entirely', async () => {
    const getWorkItemsBatch = jest.fn().mockResolvedValue([]);
    const service = makeService(
      { id: 'job-1', dryRunDiff: [{ localId: 'n0', parentLocalId: null, title: 'T', description: 'd0' }] },
      [{ localId: 'n0', adoWorkItemId: 100 }],
      getWorkItemsBatch,
    );

    const result = await service.validateCreatedTree('job-1');

    expect(result?.valid).toBe(false);
    expect(result?.mismatches).toEqual([
      { localId: 'n0', adoWorkItemId: 100, field: 'existence', expected: 'work item exists in ADO', actual: 'not found' },
    ]);
  });

  it('forwards the ADO credential to getWorkItemsBatch', async () => {
    const getWorkItemsBatch = jest.fn().mockResolvedValue([]);
    const service = makeService(
      { id: 'job-1', dryRunDiff: [{ localId: 'n0', parentLocalId: null, title: 'T', description: 'd0' }] },
      [{ localId: 'n0', adoWorkItemId: 100 }],
      getWorkItemsBatch,
    );
    const credential = { orgUrl: 'https://ado.example.com/tfs', pat: 'secret' };

    await service.validateCreatedTree('job-1', credential);

    expect(getWorkItemsBatch).toHaveBeenCalledWith([100], credential);
  });

  it('returns null for an unknown job id', async () => {
    const service = makeService(null, [], jest.fn());

    expect(await service.validateCreatedTree('unknown')).toBeNull();
  });
});

describe('JobsService.setDiffEntryExcluded', () => {
  it('flips excluded on the matching entry and persists the whole array', async () => {
    const update = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1',
          status: 'diff_ready',
          dryRunDiff: [
            { localId: 'n0', parentLocalId: null, type: 'Feature', title: 'A', description: 'd0', action: 'create', existingAdoId: null, sourceHash: 'h0', customerId: null },
          ],
        }),
        update,
      },
    };
    const service = new JobsService(prisma as any, {} as any, {} as any, {} as any, 'redis://unused');

    const result = await service.setDiffEntryExcluded('job-1', 'n0', true);

    expect(result[0].excluded).toBe(true);
    expect(update).toHaveBeenCalledWith({
      where: { id: 'job-1' },
      data: { dryRunDiff: [expect.objectContaining({ localId: 'n0', excluded: true })] },
    });
  });

  it('throws a conflict when the job is not diff_ready', async () => {
    const prisma = {
      job: { findUnique: jest.fn().mockResolvedValue({ id: 'job-1', status: 'writing', dryRunDiff: [] }) },
    };
    const service = new JobsService(prisma as any, {} as any, {} as any, {} as any, 'redis://unused');

    await expect(service.setDiffEntryExcluded('job-1', 'n0', true)).rejects.toThrow('not in a diff-editable state');
  });

  it('throws not found when the entry localId does not exist', async () => {
    const prisma = {
      job: { findUnique: jest.fn().mockResolvedValue({ id: 'job-1', status: 'diff_ready', dryRunDiff: [] }) },
    };
    const service = new JobsService(prisma as any, {} as any, {} as any, {} as any, 'redis://unused');

    await expect(service.setDiffEntryExcluded('job-1', 'missing', true)).rejects.toThrow('not found');
  });
});

describe('JobsService.editDiffEntry', () => {
  const baseEntry = { localId: 'n0', parentLocalId: null, type: 'Requirement', title: 'Old', description: 'Old desc', action: 'create', existingAdoId: null, sourceHash: 'h0', customerId: null };

  it('updates title and description on a create entry', async () => {
    const update = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({ id: 'job-1', status: 'diff_ready', dryRunDiff: [baseEntry] }),
        update,
      },
    };
    const service = new JobsService(prisma as any, {} as any, {} as any, {} as any, 'redis://unused');

    const result = await service.editDiffEntry('job-1', 'n0', { title: 'New', description: 'New desc' });

    expect(result[0].title).toBe('New');
    expect(result[0].description).toBe('New desc');
  });

  it('rejects editing a reuse entry', async () => {
    const reuseEntry = { ...baseEntry, action: 'reuse', existingAdoId: 42 };
    const update = jest.fn();
    const prisma = {
      job: { findUnique: jest.fn().mockResolvedValue({ id: 'job-1', status: 'diff_ready', dryRunDiff: [reuseEntry] }), update },
    };
    const service = new JobsService(prisma as any, {} as any, {} as any, {} as any, 'redis://unused');

    await expect(service.editDiffEntry('job-1', 'n0', { title: 'New' })).rejects.toThrow('only create entries can be edited');
    expect(update).not.toHaveBeenCalled();
  });

  it('preserves description when only title is supplied in the patch', async () => {
    const update = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({ id: 'job-1', status: 'diff_ready', dryRunDiff: [baseEntry] }),
        update,
      },
    };
    const service = new JobsService(prisma as any, {} as any, {} as any, {} as any, 'redis://unused');

    const result = await service.editDiffEntry('job-1', 'n0', { title: 'New Title' });

    expect(result[0].title).toBe('New Title');
    expect(result[0].description).toBe('Old desc');
  });

  // The HTTP controller extracts title/description independently via
  // @Body('title')/@Body('description'), so a PATCH body that omits
  // `description` still produces a patch object with an explicit
  // `description: undefined` key (JS shorthand property syntax always
  // creates the key). This reproduces that exact shape to guard against
  // the service clobbering an existing description with undefined.
  it('does not clobber description with an explicit undefined value from the controller', async () => {
    const update = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({ id: 'job-1', status: 'diff_ready', dryRunDiff: [baseEntry] }),
        update,
      },
    };
    const service = new JobsService(prisma as any, {} as any, {} as any, {} as any, 'redis://unused');

    const result = await service.editDiffEntry('job-1', 'n0', { title: 'New Title', description: undefined });

    expect(result[0].title).toBe('New Title');
    expect(result[0].description).toBe('Old desc');
  });

  // CR-7d rescore: a description edit invalidates the PREVIOUS score's
  // grounding text -- the gauge must go Stale, not keep looking fresh.
  it('marks qualityStale when the description changes on an already-scored entry', async () => {
    const scoredEntry = { ...baseEntry, qualityScore: 60, qualityCategoryScores: { clarity: 60 } };
    const update = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      job: { findUnique: jest.fn().mockResolvedValue({ id: 'job-1', status: 'diff_ready', dryRunDiff: [scoredEntry] }), update },
    };
    const service = new JobsService(prisma as any, {} as any, {} as any, {} as any, 'redis://unused');

    const result = await service.editDiffEntry('job-1', 'n0', { description: 'New desc' });

    expect(result[0].qualityStale).toBe(true);
    expect(result[0].qualityScore).toBe(60); // last-known number is KEPT, never zeroed
  });

  it('does not mark qualityStale when only title changes -- scoring judges description text only', async () => {
    const scoredEntry = { ...baseEntry, qualityScore: 60, qualityCategoryScores: { clarity: 60 } };
    const update = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      job: { findUnique: jest.fn().mockResolvedValue({ id: 'job-1', status: 'diff_ready', dryRunDiff: [scoredEntry] }), update },
    };
    const service = new JobsService(prisma as any, {} as any, {} as any, {} as any, 'redis://unused');

    const result = await service.editDiffEntry('job-1', 'n0', { title: 'New Title' });

    expect(result[0].qualityStale).toBeUndefined();
  });

  it('does not mark qualityStale on a description change when the entry was never scored', async () => {
    const update = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      job: { findUnique: jest.fn().mockResolvedValue({ id: 'job-1', status: 'diff_ready', dryRunDiff: [baseEntry] }), update },
    };
    const service = new JobsService(prisma as any, {} as any, {} as any, {} as any, 'redis://unused');

    const result = await service.editDiffEntry('job-1', 'n0', { description: 'New desc' });

    expect(result[0].qualityStale).toBeUndefined();
  });

  it('does not mark qualityStale when the new description is identical to the old one', async () => {
    const scoredEntry = { ...baseEntry, qualityScore: 60 };
    const update = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      job: { findUnique: jest.fn().mockResolvedValue({ id: 'job-1', status: 'diff_ready', dryRunDiff: [scoredEntry] }), update },
    };
    const service = new JobsService(prisma as any, {} as any, {} as any, {} as any, 'redis://unused');

    const result = await service.editDiffEntry('job-1', 'n0', { description: 'Old desc' });

    expect(result[0].qualityStale).toBeUndefined();
  });
});

describe('JobsService.rescoreDiffEntry', () => {
  const staleEntry = {
    localId: 'n0', parentLocalId: null, type: 'Requirement', title: 'Old', description: 'The system shall be fast.',
    action: 'create', existingAdoId: null, sourceHash: 'h0', customerId: null,
    qualityScore: 40, qualityIssues: ['vague_term'], qualityCategoryScores: { clarity: 20 }, qualityStale: true,
  };

  it('rescores against the entry\'s OWN existing category keys, forcing the same rubric', async () => {
    const update = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({ id: 'job-1', status: 'diff_ready', userId: 'user-1', model: 'qwen3.6:35b', dryRunDiff: [staleEntry] }),
        update,
      },
    };
    const scoreItem = jest.fn().mockResolvedValue({ qualityScore: 80, qualityIssues: [], qualityCategoryScores: { clarity: 80 } });
    const service = new JobsService(prisma as any, {} as any, {} as any, { scoreItem } as any, 'redis://unused');

    const result = await service.rescoreDiffEntry('job-1', 'n0');

    expect(scoreItem).toHaveBeenCalledWith('The system shall be fast.', ['clarity'], 'user-1', 'qwen3.6:35b');
    expect(result[0].qualityScore).toBe(80);
    expect(result[0].qualityCategoryScores).toEqual({ clarity: 80 });
    expect(result[0].qualityStale).toBe(false);
  });

  it('leaves qualityCategoryChecklist untouched across a rescore -- ingestion has no fresher citation text to offer', async () => {
    // The rescore rubric is forced to the SAME category keys (see
    // resolveCategoryChecklist above), so the entry's EXISTING checklist
    // citation text is still accurate for them -- ingestion's /score-item
    // route only ever receives category NAMES, never the raw KB definition
    // text, so there is nothing new to overwrite it with.
    const entryWithChecklist = {
      ...staleEntry,
      qualityCategoryChecklist: { clarity: 'Per your organization\'s document: "Wording is unambiguous."' },
    };
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({ id: 'job-1', status: 'diff_ready', userId: 'user-1', model: 'qwen3.6:35b', dryRunDiff: [entryWithChecklist] }),
        update: jest.fn().mockResolvedValue(undefined),
      },
    };
    const scoreItem = jest.fn().mockResolvedValue({ qualityScore: 80, qualityIssues: [], qualityCategoryScores: { clarity: 80 } });
    const service = new JobsService(prisma as any, {} as any, {} as any, { scoreItem } as any, 'redis://unused');

    const result = await service.rescoreDiffEntry('job-1', 'n0');

    expect(result[0].qualityCategoryChecklist).toEqual({
      clarity: 'Per your organization\'s document: "Wording is unambiguous."',
    });
  });

  it('passes null as the category checklist when the entry has no existing category breakdown and no scored sibling exists', async () => {
    const neverScored = { ...staleEntry, qualityScore: null, qualityCategoryScores: null, qualityStale: undefined };
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({ id: 'job-1', status: 'diff_ready', userId: null, model: null, dryRunDiff: [neverScored] }),
        update: jest.fn().mockResolvedValue(undefined),
      },
    };
    const scoreItem = jest.fn().mockResolvedValue({ qualityScore: 50, qualityIssues: [], qualityCategoryScores: null });
    const service = new JobsService(prisma as any, {} as any, {} as any, { scoreItem } as any, 'redis://unused');

    await service.rescoreDiffEntry('job-1', 'n0');

    expect(scoreItem).toHaveBeenCalledWith('The system shall be fast.', null, undefined, undefined);
  });

  // DESIGN.md §11.4.4 flags persisting the document-wide category_checklist
  // as a prerequisite so a rescore never compares two different rubrics --
  // a same-job sibling's own already-persisted qualityCategoryScores keys
  // achieve the identical guarantee without a new DB column, since one
  // whole-document scoring pass applies the SAME checklist to every
  // Requirement node in it (scoring.py's _score_all_requirements).
  it('falls back to a scored SIBLING Requirement\'s category keys when this entry has none of its own', async () => {
    const ownNeverScored = { ...staleEntry, localId: 'n0', qualityScore: null, qualityCategoryScores: null, qualityStale: undefined };
    const scoredSibling = { ...staleEntry, localId: 'n1', qualityCategoryScores: { Necessary: 90, Verifiable: 70 } };
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({ id: 'job-1', status: 'diff_ready', userId: 'user-1', model: null, dryRunDiff: [ownNeverScored, scoredSibling] }),
        update: jest.fn().mockResolvedValue(undefined),
      },
    };
    const scoreItem = jest.fn().mockResolvedValue({ qualityScore: 50, qualityIssues: [], qualityCategoryScores: { Necessary: 60, Verifiable: 55 } });
    const service = new JobsService(prisma as any, {} as any, {} as any, { scoreItem } as any, 'redis://unused');

    await service.rescoreDiffEntry('job-1', 'n0');

    expect(scoreItem).toHaveBeenCalledWith('The system shall be fast.', ['Necessary', 'Verifiable'], 'user-1', undefined);
  });

  it('rejects rescoring a non-create entry', async () => {
    const reuseEntry = { ...staleEntry, action: 'reuse', existingAdoId: 42 };
    const prisma = {
      job: { findUnique: jest.fn().mockResolvedValue({ id: 'job-1', status: 'diff_ready', dryRunDiff: [reuseEntry] }) },
    };
    const scoreItem = jest.fn();
    const service = new JobsService(prisma as any, {} as any, {} as any, { scoreItem } as any, 'redis://unused');

    await expect(service.rescoreDiffEntry('job-1', 'n0')).rejects.toThrow('only create entries can be rescored');
    expect(scoreItem).not.toHaveBeenCalled();
  });

  it('rejects rescoring a non-Requirement entry -- Epic/Feature use a separate rubric with no single-item endpoint', async () => {
    const epicEntry = { ...staleEntry, type: 'Epic' };
    const prisma = {
      job: { findUnique: jest.fn().mockResolvedValue({ id: 'job-1', status: 'diff_ready', dryRunDiff: [epicEntry] }) },
    };
    const scoreItem = jest.fn();
    const service = new JobsService(prisma as any, {} as any, {} as any, { scoreItem } as any, 'redis://unused');

    await expect(service.rescoreDiffEntry('job-1', 'n0')).rejects.toThrow('only Requirement entries can be rescored');
    expect(scoreItem).not.toHaveBeenCalled();
  });

  it('propagates an ingestion failure and never writes a fabricated fresh score', async () => {
    const update = jest.fn();
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({ id: 'job-1', status: 'diff_ready', userId: 'user-1', model: null, dryRunDiff: [staleEntry] }),
        update,
      },
    };
    const scoreItem = jest.fn().mockRejectedValue(new Error('ingestion unreachable'));
    const service = new JobsService(prisma as any, {} as any, {} as any, { scoreItem } as any, 'redis://unused');

    await expect(service.rescoreDiffEntry('job-1', 'n0')).rejects.toThrow('ingestion unreachable');
    expect(update).not.toHaveBeenCalled();
  });

  // Confirmed real bug found+fixed during the review-fix pass: a bare
  // IngestionHttpError (not a NestJS HttpException) reaching the default
  // exception filter surfaced as a generic, undiagnosable 500 -- this route
  // is the first diff-mutation route with an inline external HTTP
  // dependency in its own request/response cycle, unlike editDiffEntry/
  // addDiffEntry (pure DB/array operations, nothing to fail this way).
  it('maps a real IngestionHttpError to a BadGatewayException, preserving the real reason', async () => {
    const update = jest.fn();
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({ id: 'job-1', status: 'diff_ready', userId: 'user-1', model: null, dryRunDiff: [staleEntry] }),
        update,
      },
    };
    const scoreItem = jest.fn().mockRejectedValue(new IngestionHttpError(503, 'Ingestion /score-item request failed: LLM backend unreachable'));
    const service = new JobsService(prisma as any, {} as any, {} as any, { scoreItem } as any, 'redis://unused');

    await expect(service.rescoreDiffEntry('job-1', 'n0')).rejects.toThrow(BadGatewayException);
    await expect(service.rescoreDiffEntry('job-1', 'n0')).rejects.toThrow('LLM backend unreachable');
    expect(update).not.toHaveBeenCalled();
  });

  // Confirmed real bug found+fixed during the review-fix pass: ingestion's
  // /score-item can return a real HTTP 200 with quality_score: null (the
  // LLM response was missing/malformed for this one item -- the same
  // tolerant-parse path the batch scorer already warns on, see
  // scoring.py's score_single_requirement_text). That is NOT a network
  // failure, but it IS a failed rescore from this entry's point of view --
  // writing it through unconditionally would silently destroy the entry's
  // last real score and clear qualityStale, violating DESIGN.md §11.4.4's
  // "a failed rescore must never launder a stale number into a
  // fresh-looking one." Untested before this fix.
  it('treats a 200-OK-but-null rescore result as a failure -- never overwrites the last real score', async () => {
    const update = jest.fn();
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({ id: 'job-1', status: 'diff_ready', userId: 'user-1', model: null, dryRunDiff: [staleEntry] }),
        update,
      },
    };
    const scoreItem = jest.fn().mockResolvedValue({ qualityScore: null, qualityIssues: [], qualityCategoryScores: null });
    const service = new JobsService(prisma as any, {} as any, {} as any, { scoreItem } as any, 'redis://unused');

    await expect(service.rescoreDiffEntry('job-1', 'n0')).rejects.toThrow(BadGatewayException);
    // The entry (and its qualityStale flag) is never written -- the old
    // score of 40 stays exactly as it was, not overwritten with null.
    expect(update).not.toHaveBeenCalled();
  });

  it('rejects when the job is not in a diff-editable state', async () => {
    const prisma = {
      job: { findUnique: jest.fn().mockResolvedValue({ id: 'job-1', status: 'confirmed', dryRunDiff: [staleEntry] }) },
    };
    const service = new JobsService(prisma as any, {} as any, {} as any, {} as any, 'redis://unused');

    await expect(service.rescoreDiffEntry('job-1', 'n0')).rejects.toThrow('not in a diff-editable state');
  });
});

describe('JobsService.addDiffEntry', () => {
  const parent = { localId: 'n0', parentLocalId: null, type: 'Feature', title: 'Parent', description: 'd0', action: 'create', existingAdoId: null, sourceHash: 'h0', customerId: null, childType: 'Requirement' };

  it('appends a new create entry with sha256(description) as sourceHash, for a matching BASELINE childType', async () => {
    const update = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({ id: 'job-1', status: 'diff_ready', mode: 'baseline', dryRunDiff: [parent] }),
        update,
      },
    };
    const service = new JobsService(prisma as any, {} as any, {} as any, {} as any, 'redis://unused');

    const result = await service.addDiffEntry('job-1', { parentLocalId: 'n0', type: 'Requirement', title: 'New Req', description: 'New desc' });

    expect(result).toHaveLength(2);
    const added = result[1];
    expect(added.action).toBe('create');
    expect(added.parentLocalId).toBe('n0');
    expect(added.isManual).toBe(true);
    expect(added.childType).toBeNull();
    const crypto = require('crypto');
    expect(added.sourceHash).toBe(crypto.createHash('sha256').update('New desc').digest('hex'));
  });

  it('rejects a BASELINE add whose type does not match the parent childType', async () => {
    const prisma = {
      job: { findUnique: jest.fn().mockResolvedValue({ id: 'job-1', status: 'diff_ready', mode: 'baseline', dryRunDiff: [parent] }) },
    };
    const service = new JobsService(prisma as any, {} as any, {} as any, {} as any, 'redis://unused');

    await expect(
      service.addDiffEntry('job-1', { parentLocalId: 'n0', type: 'Feature', title: 'X', description: 'Y' }),
    ).rejects.toThrow('does not match');
  });

  it('accepts any of the three types for a SURVEY job', async () => {
    const surveyParent = { ...parent, childType: null };
    const update = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({ id: 'job-1', status: 'diff_ready', mode: 'survey', dryRunDiff: [surveyParent] }),
        update,
      },
    };
    const service = new JobsService(prisma as any, {} as any, {} as any, {} as any, 'redis://unused');

    const result = await service.addDiffEntry('job-1', { parentLocalId: 'n0', type: 'Epic', title: 'X', description: 'Y' });

    expect(result[1].type).toBe('Epic');
  });

  it('rejects an invalid type for a SURVEY job', async () => {
    const surveyParent = { ...parent, childType: null };
    const prisma = {
      job: { findUnique: jest.fn().mockResolvedValue({ id: 'job-1', status: 'diff_ready', mode: 'survey', dryRunDiff: [surveyParent] }) },
    };
    const service = new JobsService(prisma as any, {} as any, {} as any, {} as any, 'redis://unused');

    await expect(
      service.addDiffEntry('job-1', { parentLocalId: 'n0', type: 'Bug', title: 'X', description: 'Y' }),
    ).rejects.toThrow('must be one of');
  });

  it('rejects adding under a manually-added parent', async () => {
    const manualParent = { ...parent, isManual: true, childType: null };
    const prisma = {
      job: { findUnique: jest.fn().mockResolvedValue({ id: 'job-1', status: 'diff_ready', mode: 'baseline', dryRunDiff: [manualParent] }) },
    };
    const service = new JobsService(prisma as any, {} as any, {} as any, {} as any, 'redis://unused');

    await expect(
      service.addDiffEntry('job-1', { parentLocalId: 'n0', type: 'Requirement', title: 'X', description: 'Y' }),
    ).rejects.toThrow('manually-added');
  });
});

describe('JobsService.confirm — exclusion', () => {
  it('skips an excluded entry and any child of it, even if the child itself is not excluded', async () => {
    const createWorkItem = jest.fn();
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1', status: 'diff_ready', state: 'Proposed', areaPath: 'Project\\Area1',
          dryRunDiff: [
            { localId: 'n0', parentLocalId: null, type: 'Feature', title: 'Parent', description: 'd0', action: 'create', existingAdoId: null, sourceHash: 'h0', customerId: null, excluded: true },
            { localId: 'n1', parentLocalId: 'n0', type: 'Requirement', title: 'Child', description: 'd1', action: 'create', existingAdoId: null, sourceHash: 'h1', customerId: null, excluded: false },
          ],
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      auditEntry: { create: jest.fn().mockResolvedValue(undefined) },
      createdItemMapping: { findMany: jest.fn().mockResolvedValue([]), upsert: jest.fn().mockResolvedValue(undefined), update: jest.fn().mockResolvedValue(undefined) },
    };
    const service = new JobsService(
      prisma as any,
      { createWorkItem, linkParentChild: jest.fn(), discoverWorkItemTypeCategories: jest.fn().mockResolvedValue({ Epic: 'Epic', Feature: 'Feature', Requirement: 'Requirement' }) } as any,
      { record: jest.fn() } as any,
      { upsertDedupEntriesBatch: jest.fn().mockResolvedValue(undefined) } as any,
      'redis://unused',
    );

    const result = await service.confirm('job-1');

    expect(result).toEqual({ status: 'succeeded', createdCount: 0 });
    expect(createWorkItem).not.toHaveBeenCalled();
  });
});

describe('JobsService.confirm — trace links', () => {
  it('writes a resolved intraJob trace link after both endpoints have real ADO ids', async () => {
    const createWorkItem = jest.fn()
      .mockResolvedValueOnce({ id: 100 }) // n0
      .mockResolvedValueOnce({ id: 101 }); // n1
    const linkParentChild = jest.fn().mockResolvedValue(undefined);
    const linkWorkItems = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1', status: 'diff_ready', state: 'Proposed', areaPath: 'Project\\Area1',
          dryRunDiff: [
            { localId: 'n0', parentLocalId: null, type: 'Feature', title: 'Sys Req', description: 'd0', action: 'create', existingAdoId: null, sourceHash: 'h0', customerId: null, traceLinks: [] },
            {
              localId: 'n1', parentLocalId: 'n0', type: 'Requirement', title: 'Cust Req', description: 'd1', action: 'create', existingAdoId: null, sourceHash: 'h1', customerId: null,
              traceLinks: [
                { sourceLocalId: 'n1', referenceName: 'Elisra.CoveredBy-Reverse', displayName: 'Covers', targetKind: 'intraJob', targetLocalId: 'n0', resolutionStatus: 'pending' },
              ],
            },
          ],
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      auditEntry: { create: jest.fn().mockResolvedValue(undefined) },
      createdItemMapping: { findMany: jest.fn().mockResolvedValue([]), upsert: jest.fn().mockResolvedValue(undefined), update: jest.fn().mockResolvedValue(undefined) },
    };
    const service = new JobsService(
      prisma as any,
      { createWorkItem, linkParentChild, linkWorkItems, discoverWorkItemTypeCategories: jest.fn().mockResolvedValue({ Epic: 'Epic', Feature: 'Feature', Requirement: 'Requirement' }) } as any,
      { record: jest.fn() } as any,
      { upsertDedupEntriesBatch: jest.fn().mockResolvedValue(undefined) } as any,
      'redis://unused',
    );

    await service.confirm('job-1');

    expect(linkWorkItems).toHaveBeenCalledWith(101, 100, 'Elisra.CoveredBy-Reverse', undefined);
  });

  it('skips writing an unresolved trace link without failing confirm', async () => {
    const createWorkItem = jest.fn().mockResolvedValueOnce({ id: 100 });
    const linkParentChild = jest.fn().mockResolvedValue(undefined);
    const linkWorkItems = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1', status: 'diff_ready', state: 'Proposed', areaPath: 'Project\\Area1',
          dryRunDiff: [
            {
              localId: 'n0', parentLocalId: null, type: 'Requirement', title: 'Req', description: 'd0', action: 'create', existingAdoId: null, sourceHash: 'h0', customerId: null,
              traceLinks: [
                { sourceLocalId: 'n0', referenceName: 'Elisra.CoveredBy-Forward', displayName: 'Covered by', targetKind: 'crossJob', targetCustomerId: 'REQ-MISSING', resolutionStatus: 'unresolved' },
              ],
            },
          ],
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      auditEntry: { create: jest.fn().mockResolvedValue(undefined) },
      createdItemMapping: { findMany: jest.fn().mockResolvedValue([]), upsert: jest.fn().mockResolvedValue(undefined), update: jest.fn().mockResolvedValue(undefined) },
    };
    const service = new JobsService(
      prisma as any,
      { createWorkItem, linkParentChild, linkWorkItems, discoverWorkItemTypeCategories: jest.fn().mockResolvedValue({ Epic: 'Epic', Feature: 'Feature', Requirement: 'Requirement' }) } as any,
      { record: jest.fn() } as any,
      { upsertDedupEntriesBatch: jest.fn().mockResolvedValue(undefined) } as any,
      'redis://unused',
    );

    const result = await service.confirm('job-1');

    expect(result).toEqual({ status: 'succeeded', createdCount: 1 });
    expect(linkWorkItems).not.toHaveBeenCalled();
  });

  it('writes an already-resolved crossJob trace link using its resolvedAdoId', async () => {
    const createWorkItem = jest.fn().mockResolvedValueOnce({ id: 100 });
    const linkParentChild = jest.fn().mockResolvedValue(undefined);
    const linkWorkItems = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1', status: 'diff_ready', state: 'Proposed', areaPath: 'Project\\Area1',
          dryRunDiff: [
            {
              localId: 'n0', parentLocalId: null, type: 'Requirement', title: 'Req', description: 'd0', action: 'create', existingAdoId: null, sourceHash: 'h0', customerId: null,
              traceLinks: [
                { sourceLocalId: 'n0', referenceName: 'System.LinkTypes.Affects-Forward', displayName: 'Affects', targetKind: 'crossJob', targetCustomerId: 'REQ-SYS-012', resolvedAdoId: 555, resolutionStatus: 'resolved' },
              ],
            },
          ],
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      auditEntry: { create: jest.fn().mockResolvedValue(undefined) },
      createdItemMapping: { findMany: jest.fn().mockResolvedValue([]), upsert: jest.fn().mockResolvedValue(undefined), update: jest.fn().mockResolvedValue(undefined) },
    };
    const service = new JobsService(
      prisma as any,
      { createWorkItem, linkParentChild, linkWorkItems, discoverWorkItemTypeCategories: jest.fn().mockResolvedValue({ Epic: 'Epic', Feature: 'Feature', Requirement: 'Requirement' }) } as any,
      { record: jest.fn() } as any,
      { upsertDedupEntriesBatch: jest.fn().mockResolvedValue(undefined) } as any,
      'redis://unused',
    );

    await service.confirm('job-1');

    expect(linkWorkItems).toHaveBeenCalledWith(100, 555, 'System.LinkTypes.Affects-Forward', undefined);
  });

  it('does not abort confirm when linkWorkItems rejects — the failure is logged and swallowed', async () => {
    const createWorkItem = jest.fn()
      .mockResolvedValueOnce({ id: 100 }) // n0
      .mockResolvedValueOnce({ id: 101 }); // n1
    const linkParentChild = jest.fn().mockResolvedValue(undefined);
    const linkWorkItems = jest.fn().mockRejectedValue(new Error('ADO rejected the rel'));
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1', status: 'diff_ready', state: 'Proposed', areaPath: 'Project\\Area1',
          dryRunDiff: [
            { localId: 'n0', parentLocalId: null, type: 'Feature', title: 'Sys Req', description: 'd0', action: 'create', existingAdoId: null, sourceHash: 'h0', customerId: null, traceLinks: [] },
            {
              localId: 'n1', parentLocalId: 'n0', type: 'Requirement', title: 'Cust Req', description: 'd1', action: 'create', existingAdoId: null, sourceHash: 'h1', customerId: null,
              traceLinks: [
                { sourceLocalId: 'n1', referenceName: 'Elisra.CoveredBy-Reverse', displayName: 'Covers', targetKind: 'intraJob', targetLocalId: 'n0', resolutionStatus: 'pending' },
              ],
            },
          ],
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      auditEntry: { create: jest.fn().mockResolvedValue(undefined) },
      createdItemMapping: { findMany: jest.fn().mockResolvedValue([]), upsert: jest.fn().mockResolvedValue(undefined), update: jest.fn().mockResolvedValue(undefined) },
    };
    const service = new JobsService(
      prisma as any,
      { createWorkItem, linkParentChild, linkWorkItems, discoverWorkItemTypeCategories: jest.fn().mockResolvedValue({ Epic: 'Epic', Feature: 'Feature', Requirement: 'Requirement' }) } as any,
      { record: jest.fn() } as any,
      { upsertDedupEntriesBatch: jest.fn().mockResolvedValue(undefined) } as any,
      'redis://unused',
    );

    const result = await service.confirm('job-1');

    expect(linkWorkItems).toHaveBeenCalledWith(101, 100, 'Elisra.CoveredBy-Reverse', undefined);
    expect(result).toEqual({ status: 'succeeded', createdCount: 2 });
  });

  it('attempts every trace link even when one of several rejects, now that they run concurrently instead of one at a time', async () => {
    const createWorkItem = jest.fn()
      .mockResolvedValueOnce({ id: 100 }) // n0
      .mockResolvedValueOnce({ id: 101 }) // n1
      .mockResolvedValueOnce({ id: 102 }); // n2
    const linkParentChild = jest.fn().mockResolvedValue(undefined);
    const linkWorkItems = jest.fn()
      .mockRejectedValueOnce(new Error('ADO rejected the rel'))
      .mockResolvedValue(undefined);
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1', status: 'diff_ready', state: 'Proposed', areaPath: 'Project\\Area1',
          dryRunDiff: [
            { localId: 'n0', parentLocalId: null, type: 'Feature', title: 'Sys Req', description: 'd0', action: 'create', existingAdoId: null, sourceHash: 'h0', customerId: null, traceLinks: [] },
            {
              localId: 'n1', parentLocalId: 'n0', type: 'Requirement', title: 'Cust Req 1', description: 'd1', action: 'create', existingAdoId: null, sourceHash: 'h1', customerId: null,
              traceLinks: [
                { sourceLocalId: 'n1', referenceName: 'Elisra.CoveredBy-Reverse', displayName: 'Covers', targetKind: 'intraJob', targetLocalId: 'n0', resolutionStatus: 'pending' },
              ],
            },
            {
              localId: 'n2', parentLocalId: 'n0', type: 'Requirement', title: 'Cust Req 2', description: 'd2', action: 'create', existingAdoId: null, sourceHash: 'h2', customerId: null,
              traceLinks: [
                { sourceLocalId: 'n2', referenceName: 'Elisra.CoveredBy-Reverse', displayName: 'Covers', targetKind: 'intraJob', targetLocalId: 'n0', resolutionStatus: 'pending' },
              ],
            },
          ],
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      auditEntry: { create: jest.fn().mockResolvedValue(undefined) },
      createdItemMapping: { findMany: jest.fn().mockResolvedValue([]), upsert: jest.fn().mockResolvedValue(undefined), update: jest.fn().mockResolvedValue(undefined) },
    };
    const service = new JobsService(
      prisma as any,
      { createWorkItem, linkParentChild, linkWorkItems, discoverWorkItemTypeCategories: jest.fn().mockResolvedValue({ Epic: 'Epic', Feature: 'Feature', Requirement: 'Requirement' }) } as any,
      { record: jest.fn() } as any,
      { upsertDedupEntriesBatch: jest.fn().mockResolvedValue(undefined) } as any,
      'redis://unused',
    );

    const result = await service.confirm('job-1');

    // Both trace links attempted despite the first one rejecting -- a
    // sequential loop with an unguarded await would have stopped after the
    // first failure (or, pre-fix, thrown out of confirm entirely).
    expect(linkWorkItems).toHaveBeenCalledTimes(2);
    expect(linkWorkItems).toHaveBeenCalledWith(101, 100, 'Elisra.CoveredBy-Reverse', undefined);
    expect(linkWorkItems).toHaveBeenCalledWith(102, 100, 'Elisra.CoveredBy-Reverse', undefined);
    expect(result).toEqual({ status: 'succeeded', createdCount: 3 });
  });
});

describe('JobsService.confirm — figure attachments', () => {
  it('uploads a figure_ids-cited JobFigureFile as an ADO attachment and deletes the row on success', async () => {
    const createWorkItem = jest.fn().mockResolvedValueOnce({ id: 100 });
    const linkParentChild = jest.fn().mockResolvedValue(undefined);
    const uploadAttachment = jest.fn().mockResolvedValue(undefined);
    const figureFileDelete = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1', status: 'diff_ready', state: 'Proposed', areaPath: 'Project\\Area1',
          dryRunDiff: [
            { localId: 'n0', parentLocalId: null, type: 'Requirement', title: 'Req', description: 'd0', action: 'create', existingAdoId: null, sourceHash: 'h0', customerId: null, figureIds: ['f0'] },
          ],
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      auditEntry: { create: jest.fn().mockResolvedValue(undefined) },
      createdItemMapping: { findMany: jest.fn().mockResolvedValue([]), upsert: jest.fn().mockResolvedValue(undefined), update: jest.fn().mockResolvedValue(undefined) },
      jobFigureFile: {
        findMany: jest.fn().mockResolvedValue([{ id: 'jff-1', jobId: 'job-1', figureId: 'f0', bytes: Buffer.from('png bytes'), mimeType: 'image/png' }]),
        delete: figureFileDelete,
      },
    };
    const service = new JobsService(
      prisma as any,
      { createWorkItem, linkParentChild, uploadAttachment, discoverWorkItemTypeCategories: jest.fn().mockResolvedValue({ Epic: 'Epic', Feature: 'Feature', Requirement: 'Requirement' }) } as any,
      { record: jest.fn() } as any,
      { upsertDedupEntriesBatch: jest.fn().mockResolvedValue(undefined) } as any,
      'redis://unused',
    );

    const result = await service.confirm('job-1');

    expect(uploadAttachment).toHaveBeenCalledWith(100, 'f0.png', Buffer.from('png bytes').toString('base64'), 'image/png', undefined);
    expect(figureFileDelete).toHaveBeenCalledWith({ where: { id: 'jff-1' } });
    expect(result).toEqual({ status: 'succeeded', createdCount: 1 });
  });

  it('skips a JobFigureFile row no node references and never uploads or deletes it', async () => {
    const createWorkItem = jest.fn().mockResolvedValueOnce({ id: 100 });
    const linkParentChild = jest.fn().mockResolvedValue(undefined);
    const uploadAttachment = jest.fn().mockResolvedValue(undefined);
    const figureFileDelete = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1', status: 'diff_ready', state: 'Proposed', areaPath: 'Project\\Area1',
          dryRunDiff: [
            { localId: 'n0', parentLocalId: null, type: 'Requirement', title: 'Req', description: 'd0', action: 'create', existingAdoId: null, sourceHash: 'h0', customerId: null, figureIds: [] },
          ],
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      auditEntry: { create: jest.fn().mockResolvedValue(undefined) },
      createdItemMapping: { findMany: jest.fn().mockResolvedValue([]), upsert: jest.fn().mockResolvedValue(undefined), update: jest.fn().mockResolvedValue(undefined) },
      jobFigureFile: {
        findMany: jest.fn().mockResolvedValue([{ id: 'jff-1', jobId: 'job-1', figureId: 'f9', bytes: Buffer.from('unreferenced'), mimeType: 'image/png' }]),
        delete: figureFileDelete,
      },
    };
    const service = new JobsService(
      prisma as any,
      { createWorkItem, linkParentChild, uploadAttachment, discoverWorkItemTypeCategories: jest.fn().mockResolvedValue({ Epic: 'Epic', Feature: 'Feature', Requirement: 'Requirement' }) } as any,
      { record: jest.fn() } as any,
      { upsertDedupEntriesBatch: jest.fn().mockResolvedValue(undefined) } as any,
      'redis://unused',
    );

    await service.confirm('job-1');

    expect(uploadAttachment).not.toHaveBeenCalled();
    expect(figureFileDelete).not.toHaveBeenCalled();
  });

  it('never queries JobFigureFile when no entry has figure_ids and no rows exist', async () => {
    const createWorkItem = jest.fn().mockResolvedValueOnce({ id: 100 });
    const linkParentChild = jest.fn().mockResolvedValue(undefined);
    const figureFileFindMany = jest.fn().mockResolvedValue([]);
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1', status: 'diff_ready', state: 'Proposed', areaPath: 'Project\\Area1',
          dryRunDiff: [
            { localId: 'n0', parentLocalId: null, type: 'Requirement', title: 'Req', description: 'd0', action: 'create', existingAdoId: null, sourceHash: 'h0', customerId: null },
          ],
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      auditEntry: { create: jest.fn().mockResolvedValue(undefined) },
      createdItemMapping: { findMany: jest.fn().mockResolvedValue([]), upsert: jest.fn().mockResolvedValue(undefined), update: jest.fn().mockResolvedValue(undefined) },
      jobFigureFile: { findMany: figureFileFindMany, delete: jest.fn() },
    };
    const service = new JobsService(
      prisma as any,
      { createWorkItem, linkParentChild, discoverWorkItemTypeCategories: jest.fn().mockResolvedValue({ Epic: 'Epic', Feature: 'Feature', Requirement: 'Requirement' }) } as any,
      { record: jest.fn() } as any,
      { upsertDedupEntriesBatch: jest.fn().mockResolvedValue(undefined) } as any,
      'redis://unused',
    );

    const result = await service.confirm('job-1');

    expect(figureFileFindMany).toHaveBeenCalledWith({ where: { jobId: 'job-1' } });
    expect(result).toEqual({ status: 'succeeded', createdCount: 1 });
  });

  it('does not abort or revert confirm when uploadAttachment rejects — best-effort, logged and swallowed', async () => {
    const createWorkItem = jest.fn().mockResolvedValueOnce({ id: 100 });
    const linkParentChild = jest.fn().mockResolvedValue(undefined);
    const uploadAttachment = jest.fn().mockRejectedValue(new Error('ADO attachment upload failed'));
    const figureFileDelete = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1', status: 'diff_ready', state: 'Proposed', areaPath: 'Project\\Area1',
          dryRunDiff: [
            { localId: 'n0', parentLocalId: null, type: 'Requirement', title: 'Req', description: 'd0', action: 'create', existingAdoId: null, sourceHash: 'h0', customerId: null, figureIds: ['f0'] },
          ],
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      auditEntry: { create: jest.fn().mockResolvedValue(undefined) },
      createdItemMapping: { findMany: jest.fn().mockResolvedValue([]), upsert: jest.fn().mockResolvedValue(undefined), update: jest.fn().mockResolvedValue(undefined) },
      jobFigureFile: {
        findMany: jest.fn().mockResolvedValue([{ id: 'jff-1', jobId: 'job-1', figureId: 'f0', bytes: Buffer.from('png bytes'), mimeType: 'image/png' }]),
        delete: figureFileDelete,
      },
    };
    const service = new JobsService(
      prisma as any,
      { createWorkItem, linkParentChild, uploadAttachment, discoverWorkItemTypeCategories: jest.fn().mockResolvedValue({ Epic: 'Epic', Feature: 'Feature', Requirement: 'Requirement' }) } as any,
      { record: jest.fn() } as any,
      { upsertDedupEntriesBatch: jest.fn().mockResolvedValue(undefined) } as any,
      'redis://unused',
    );

    const result = await service.confirm('job-1');

    expect(figureFileDelete).not.toHaveBeenCalled();
    expect(result).toEqual({ status: 'succeeded', createdCount: 1 });
  });

  it('does not abort or revert confirm when the whole figure-attachment phase throws (e.g. JobFigureFile query fails)', async () => {
    const createWorkItem = jest.fn().mockResolvedValueOnce({ id: 100 });
    const linkParentChild = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1', status: 'diff_ready', state: 'Proposed', areaPath: 'Project\\Area1',
          dryRunDiff: [
            { localId: 'n0', parentLocalId: null, type: 'Requirement', title: 'Req', description: 'd0', action: 'create', existingAdoId: null, sourceHash: 'h0', customerId: null, figureIds: ['f0'] },
          ],
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      auditEntry: { create: jest.fn().mockResolvedValue(undefined) },
      createdItemMapping: { findMany: jest.fn().mockResolvedValue([]), upsert: jest.fn().mockResolvedValue(undefined), update: jest.fn().mockResolvedValue(undefined) },
      jobFigureFile: { findMany: jest.fn().mockRejectedValue(new Error('connection lost')) },
    };
    const service = new JobsService(
      prisma as any,
      { createWorkItem, linkParentChild, discoverWorkItemTypeCategories: jest.fn().mockResolvedValue({ Epic: 'Epic', Feature: 'Feature', Requirement: 'Requirement' }) } as any,
      { record: jest.fn() } as any,
      { upsertDedupEntriesBatch: jest.fn().mockResolvedValue(undefined) } as any,
      'redis://unused',
    );

    const result = await service.confirm('job-1');

    expect(result).toEqual({ status: 'succeeded', createdCount: 1 });
    expect(prisma.job.update).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'diff_ready' }) }));
  });

  it('excludes a deselected/excluded entry from figure attachment even if it carries figure_ids', async () => {
    const createWorkItem = jest.fn().mockResolvedValueOnce({ id: 100 }); // only n1 is created
    const linkParentChild = jest.fn().mockResolvedValue(undefined);
    const uploadAttachment = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1', status: 'diff_ready', state: 'Proposed', areaPath: 'Project\\Area1',
          dryRunDiff: [
            { localId: 'n0', parentLocalId: null, type: 'Requirement', title: 'Excluded', description: 'd0', action: 'create', existingAdoId: null, sourceHash: 'h0', customerId: null, figureIds: ['f0'], excluded: true },
            { localId: 'n1', parentLocalId: null, type: 'Requirement', title: 'Included', description: 'd1', action: 'create', existingAdoId: null, sourceHash: 'h1', customerId: null, figureIds: ['f1'] },
          ],
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      auditEntry: { create: jest.fn().mockResolvedValue(undefined) },
      createdItemMapping: { findMany: jest.fn().mockResolvedValue([]), upsert: jest.fn().mockResolvedValue(undefined), update: jest.fn().mockResolvedValue(undefined) },
      jobFigureFile: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'jff-0', jobId: 'job-1', figureId: 'f0', bytes: Buffer.from('excluded'), mimeType: 'image/png' },
          { id: 'jff-1', jobId: 'job-1', figureId: 'f1', bytes: Buffer.from('included'), mimeType: 'image/png' },
        ]),
        delete: jest.fn().mockResolvedValue(undefined),
      },
    };
    const service = new JobsService(
      prisma as any,
      { createWorkItem, linkParentChild, uploadAttachment, discoverWorkItemTypeCategories: jest.fn().mockResolvedValue({ Epic: 'Epic', Feature: 'Feature', Requirement: 'Requirement' }) } as any,
      { record: jest.fn() } as any,
      { upsertDedupEntriesBatch: jest.fn().mockResolvedValue(undefined) } as any,
      'redis://unused',
    );

    await service.confirm('job-1');

    expect(uploadAttachment).toHaveBeenCalledTimes(1);
    expect(uploadAttachment).toHaveBeenCalledWith(100, 'f1.png', Buffer.from('included').toString('base64'), 'image/png', undefined);
  });

  it('serializes figure attachments to the SAME ADO work item, never running two concurrently', async () => {
    // Real, confirmed bug this locks in: two attachment PATCHes racing
    // against the SAME work item both read its revision before either
    // commits -- ADO's optimistic-concurrency check 409s the second to
    // land (TF26071 "This work item has been changed by someone else
    // since you opened it"). Reproduced live: 8 of 18 figures on one real
    // Feature silently failed this way, matching the user's reported
    // "10 landed" count. This test proves the fix -- attachments to the
    // SAME adoId never overlap in time -- by tracking whether a second
    // call starts while an earlier call for the same adoId is still
    // pending.
    const createWorkItem = jest.fn().mockResolvedValueOnce({ id: 100 });
    const linkParentChild = jest.fn().mockResolvedValue(undefined);
    const inFlightByAdoId = new Set<number>();
    let overlapDetected = false;
    const uploadAttachment = jest.fn().mockImplementation(async (adoId: number) => {
      if (inFlightByAdoId.has(adoId)) overlapDetected = true;
      inFlightByAdoId.add(adoId);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlightByAdoId.delete(adoId);
    });
    const figureFileDelete = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1', status: 'diff_ready', state: 'Proposed', areaPath: 'Project\\Area1',
          dryRunDiff: [
            { localId: 'n0', parentLocalId: null, type: 'Feature', title: 'F', description: 'd0', action: 'create', existingAdoId: null, sourceHash: 'h0', customerId: null, figureIds: ['f0', 'f1', 'f2'] },
          ],
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      auditEntry: { create: jest.fn().mockResolvedValue(undefined) },
      createdItemMapping: { findMany: jest.fn().mockResolvedValue([]), upsert: jest.fn().mockResolvedValue(undefined), update: jest.fn().mockResolvedValue(undefined) },
      jobFigureFile: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'jff-0', jobId: 'job-1', figureId: 'f0', bytes: Buffer.from('a'), mimeType: 'image/png' },
          { id: 'jff-1', jobId: 'job-1', figureId: 'f1', bytes: Buffer.from('b'), mimeType: 'image/png' },
          { id: 'jff-2', jobId: 'job-1', figureId: 'f2', bytes: Buffer.from('c'), mimeType: 'image/png' },
        ]),
        delete: figureFileDelete,
      },
    };
    const service = new JobsService(
      prisma as any,
      { createWorkItem, linkParentChild, uploadAttachment, discoverWorkItemTypeCategories: jest.fn().mockResolvedValue({ Epic: 'Epic', Feature: 'Feature', Requirement: 'Requirement' }) } as any,
      { record: jest.fn() } as any,
      { upsertDedupEntriesBatch: jest.fn().mockResolvedValue(undefined) } as any,
      'redis://unused',
      undefined,
      4, // writeConcurrency -- deliberately > 1, so overlap would show up if the 3 figures for this one work item weren't serialized
    );

    await service.confirm('job-1');

    expect(uploadAttachment).toHaveBeenCalledTimes(3);
    expect(overlapDetected).toBe(false);
  });
});

describe('JobsService.confirm — dryRunDiff refresh on success', () => {
  it('rewrites dryRunDiff with real ADO ids on success, so a re-fetched job stops showing stale create placeholders', async () => {
    // Real, confirmed bug this locks in: GET /jobs/:id served the frozen
    // pre-confirm dryRunDiff forever, even on a fully 'succeeded' job --
    // every entry kept existingAdoId: null / action: 'create', which is
    // exactly what NodeDetailPanel.tsx gates its "not available for a new
    // item in this view" figure-upload placeholder on. Reproduced live
    // against a real confirmed job.
    const createWorkItem = jest.fn().mockResolvedValueOnce({ id: 100 }).mockResolvedValueOnce({ id: 101 });
    const linkParentChild = jest.fn().mockResolvedValue(undefined);
    const jobUpdate = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1', status: 'diff_ready', state: 'Proposed', areaPath: 'Project\\Area1',
          dryRunDiff: [
            { localId: 'n0', parentLocalId: null, type: 'Feature', title: 'Parent', description: 'd0', action: 'create', existingAdoId: null, sourceHash: 'h0', customerId: null },
            { localId: 'n1', parentLocalId: 'n0', type: 'Requirement', title: 'Child', description: 'd1', action: 'create', existingAdoId: null, sourceHash: 'h1', customerId: null },
          ],
        }),
        update: jobUpdate,
      },
      auditEntry: { create: jest.fn().mockResolvedValue(undefined) },
      createdItemMapping: { findMany: jest.fn().mockResolvedValue([]), upsert: jest.fn().mockResolvedValue(undefined), update: jest.fn().mockResolvedValue(undefined) },
    };
    const service = new JobsService(
      prisma as any,
      { createWorkItem, linkParentChild, discoverWorkItemTypeCategories: jest.fn().mockResolvedValue({ Epic: 'Epic', Feature: 'Feature', Requirement: 'Requirement' }) } as any,
      { record: jest.fn() } as any,
      { upsertDedupEntriesBatch: jest.fn().mockResolvedValue(undefined) } as any,
      'redis://unused',
    );

    await service.confirm('job-1');

    const finalUpdateCall = jobUpdate.mock.calls.find((call) => call[0].data.status === 'succeeded');
    expect(finalUpdateCall).toBeDefined();
    const updatedDiff = finalUpdateCall![0].data.dryRunDiff as { localId: string; existingAdoId: number | null; action: string }[];
    expect(updatedDiff.find((e) => e.localId === 'n0')).toMatchObject({ existingAdoId: 100, action: 'create' });
    expect(updatedDiff.find((e) => e.localId === 'n1')).toMatchObject({ existingAdoId: 101, action: 'create' });
  });

  it('does NOT rewrite dryRunDiff on the partial-failure revert path — only the final success path may flip action to reuse', async () => {
    // Deliberately narrow scope, not an oversight: confirm() refuses to
    // run again once status is 'succeeded' (guarded at the very top of
    // this method), so rewriting action to 'reuse' on the SUCCESS path is
    // permanent and safe. Doing the same rewrite in the catch-block's
    // revert-to-'diff_ready' path would be actively wrong -- a resumed
    // retry's own toLink filter treats action === 'reuse' as "already
    // linked from an earlier, unrelated job, skip re-linking", which is
    // false for an item THIS job just created but hadn't linked yet when
    // it failed.
    // Two mocked values required (not one as in the original brief): both the parent (n0)
    // and child (n1) entries must successfully create in the create-phase loop before
    // the link-phase's rejection can be reached. With only one mock value, the second
    // createWorkItem call would resolve to undefined, causing a TypeError before the
    // intended linkParentChild rejection failure path is ever exercised.
    const createWorkItem = jest.fn().mockResolvedValueOnce({ id: 100 }).mockResolvedValueOnce({ id: 101 });
    const linkParentChild = jest.fn().mockRejectedValue(new Error('ADO link failed'));
    const jobUpdate = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1', status: 'diff_ready', state: 'Proposed', areaPath: 'Project\\Area1',
          dryRunDiff: [
            { localId: 'n0', parentLocalId: null, type: 'Feature', title: 'Parent', description: 'd0', action: 'create', existingAdoId: null, sourceHash: 'h0', customerId: null },
            { localId: 'n1', parentLocalId: 'n0', type: 'Requirement', title: 'Child', description: 'd1', action: 'create', existingAdoId: null, sourceHash: 'h1', customerId: null },
          ],
        }),
        update: jobUpdate,
      },
      auditEntry: { create: jest.fn().mockResolvedValue(undefined) },
      createdItemMapping: { findMany: jest.fn().mockResolvedValue([]), upsert: jest.fn().mockResolvedValue(undefined), update: jest.fn().mockResolvedValue(undefined) },
    };
    const service = new JobsService(
      prisma as any,
      { createWorkItem, linkParentChild, discoverWorkItemTypeCategories: jest.fn().mockResolvedValue({ Epic: 'Epic', Feature: 'Feature', Requirement: 'Requirement' }) } as any,
      { record: jest.fn() } as any,
      { upsertDedupEntriesBatch: jest.fn().mockResolvedValue(undefined) } as any,
      'redis://unused',
    );

    await expect(service.confirm('job-1')).rejects.toThrow('ADO link failed');

    const revertCall = jobUpdate.mock.calls.find((call) => call[0].data.status === 'diff_ready');
    expect(revertCall).toBeDefined();
    expect(revertCall![0].data.dryRunDiff).toBeUndefined();
  });

  it('does not relabel pre-existing reuse/dedup_skip entries when refreshing existingAdoId', async () => {
    // Real bug this locks in: adoIdByLocalId is seeded from BOTH newly
    // created items and pre-existing reuse/dedup_skip matches (see the
    // seeding around line 1067-1068), so a blanket action: 'reuse' rewrite
    // here silently destroyed the dedup_skip near-duplicate distinction
    // getSummary() and the frontend's ActionBadge both depend on.
    const createWorkItem = jest.fn().mockResolvedValueOnce({ id: 100 });
    const linkParentChild = jest.fn().mockResolvedValue(undefined);
    const jobUpdate = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1', status: 'diff_ready', state: 'Proposed', areaPath: 'Project\\Area1',
          dryRunDiff: [
            { localId: 'n0', parentLocalId: null, type: 'Feature', title: 'Parent', description: 'd0', action: 'create', existingAdoId: null, sourceHash: 'h0', customerId: null },
            { localId: 'n1', parentLocalId: null, type: 'Requirement', title: 'Reused', description: 'd1', action: 'reuse', existingAdoId: 555, sourceHash: 'h1', customerId: null },
            { localId: 'n2', parentLocalId: null, type: 'Requirement', title: 'Near-dup', description: 'd2', action: 'dedup_skip', existingAdoId: 777, sourceHash: 'h2', customerId: null },
          ],
        }),
        update: jobUpdate,
      },
      auditEntry: { create: jest.fn().mockResolvedValue(undefined) },
      createdItemMapping: { findMany: jest.fn().mockResolvedValue([]), upsert: jest.fn().mockResolvedValue(undefined), update: jest.fn().mockResolvedValue(undefined) },
    };
    const service = new JobsService(
      prisma as any,
      { createWorkItem, linkParentChild, discoverWorkItemTypeCategories: jest.fn().mockResolvedValue({ Epic: 'Epic', Feature: 'Feature', Requirement: 'Requirement' }) } as any,
      { record: jest.fn() } as any,
      { upsertDedupEntriesBatch: jest.fn().mockResolvedValue(undefined) } as any,
      'redis://unused',
    );

    await service.confirm('job-1');

    const finalUpdateCall = jobUpdate.mock.calls.find((call) => call[0].data.status === 'succeeded');
    const updatedDiff = finalUpdateCall![0].data.dryRunDiff as { localId: string; existingAdoId: number | null; action: string }[];
    expect(updatedDiff.find((e) => e.localId === 'n0')).toMatchObject({ existingAdoId: 100, action: 'create' });
    expect(updatedDiff.find((e) => e.localId === 'n1')).toMatchObject({ existingAdoId: 555, action: 'reuse' });
    expect(updatedDiff.find((e) => e.localId === 'n2')).toMatchObject({ existingAdoId: 777, action: 'dedup_skip' });
  });
});

describe('JobsService.confirm — sibling creation order', () => {
  it('creates siblings under the SAME parent strictly in document order, never two in flight at once', async () => {
    // Real requirement this fixes (clarified live by the user): an ADO
    // "direct links"/tree query sorts each parent's children by
    // System.Id ascending by default, and ADO assigns System.Id in
    // request-ARRIVAL order, not caller-array order. With flat
    // concurrency across every create regardless of parent, up to
    // writeConcurrency siblings of the SAME parent could be in flight at
    // once -- network jitter alone could hand a LATER document-order
    // child a LOWER id than an earlier one, scrambling the tree view
    // relative to this app's own order. This test proves siblings of one
    // parent are created strictly in sequence, in document order.
    const siblingTitles = ['Child 0', 'Child 1', 'Child 2'];
    const inFlightSiblings = new Set<string>();
    let siblingOverlapDetected = false;
    const callOrder: string[] = [];
    let nextId = 101;
    const createWorkItem = jest.fn().mockImplementation(async (_type: string, fields: Record<string, string>) => {
      const title = fields['System.Title'];
      callOrder.push(title);
      const isSibling = siblingTitles.includes(title);
      if (isSibling) {
        if (inFlightSiblings.size > 0) siblingOverlapDetected = true;
        inFlightSiblings.add(title);
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (isSibling) inFlightSiblings.delete(title);
      return { id: title === 'Parent' ? 100 : nextId++ };
    });
    const linkParentChild = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1', status: 'diff_ready', state: 'Proposed', areaPath: 'Project\\Area1',
          dryRunDiff: [
            { localId: 'p0', parentLocalId: null, type: 'Feature', title: 'Parent', description: 'd', action: 'create', existingAdoId: null, sourceHash: 'hp', customerId: null },
            { localId: 'n0', parentLocalId: 'p0', type: 'Requirement', title: 'Child 0', description: 'd0', action: 'create', existingAdoId: null, sourceHash: 'h0', customerId: null },
            { localId: 'n1', parentLocalId: 'p0', type: 'Requirement', title: 'Child 1', description: 'd1', action: 'create', existingAdoId: null, sourceHash: 'h1', customerId: null },
            { localId: 'n2', parentLocalId: 'p0', type: 'Requirement', title: 'Child 2', description: 'd2', action: 'create', existingAdoId: null, sourceHash: 'h2', customerId: null },
          ],
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      auditEntry: { create: jest.fn().mockResolvedValue(undefined) },
      createdItemMapping: { findMany: jest.fn().mockResolvedValue([]), upsert: jest.fn().mockResolvedValue(undefined), update: jest.fn().mockResolvedValue(undefined) },
    };
    const service = new JobsService(
      prisma as any,
      { createWorkItem, linkParentChild, discoverWorkItemTypeCategories: jest.fn().mockResolvedValue({ Epic: 'Epic', Feature: 'Feature', Requirement: 'Requirement' }) } as any,
      { record: jest.fn() } as any,
      { upsertDedupEntriesBatch: jest.fn().mockResolvedValue(undefined) } as any,
      'redis://unused',
      undefined,
      4, // writeConcurrency -- deliberately > 1, so overlap would show up if the 3 siblings weren't serialized relative to each other
    );

    const result = await service.confirm('job-1');

    expect(siblingOverlapDetected).toBe(false);
    expect(callOrder.filter((t) => siblingTitles.includes(t))).toEqual(['Child 0', 'Child 1', 'Child 2']);
    expect(result).toEqual({ status: 'succeeded', createdCount: 4 });
  });

  it('creates DIFFERENT parents subtrees concurrently, while still serializing each parent\'s own children', async () => {
    // Real risk this guards against: grouping by parent must not collapse
    // into one big sequential queue for the WHOLE job -- only siblings of
    // the SAME parent need strict order. Two DISTINCT parents (p0, p1),
    // each with two children, should have their CHILD groups overlap in
    // time with each other, while each parent's own two children never
    // overlap with EACH OTHER.
    const groupByTitle: Record<string, string> = { A0: 'A', A1: 'A', B0: 'B', B1: 'B' };
    const inFlightByGroup = new Map<string, Set<string>>();
    let crossGroupOverlapDetected = false;
    let sameGroupOverlapDetected = false;
    let nextChildId = 200;
    const createWorkItem = jest.fn().mockImplementation(async (_type: string, fields: Record<string, string>) => {
      const title = fields['System.Title'];
      if (title === 'Parent0' || title === 'Parent1') {
        return { id: title === 'Parent0' ? 100 : 101 };
      }
      const group = groupByTitle[title];
      const otherGroupsInFlight = Array.from(inFlightByGroup.entries()).some(([g, set]) => g !== group && set.size > 0);
      if (otherGroupsInFlight) crossGroupOverlapDetected = true;
      const sameGroupSet = inFlightByGroup.get(group) ?? new Set<string>();
      if (sameGroupSet.size > 0) sameGroupOverlapDetected = true;
      sameGroupSet.add(title);
      inFlightByGroup.set(group, sameGroupSet);
      await new Promise((resolve) => setTimeout(resolve, 5));
      sameGroupSet.delete(title);
      return { id: nextChildId++ };
    });
    const linkParentChild = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1', status: 'diff_ready', state: 'Proposed', areaPath: 'Project\\Area1',
          dryRunDiff: [
            { localId: 'p0', parentLocalId: null, type: 'Feature', title: 'Parent0', description: 'd', action: 'create', existingAdoId: null, sourceHash: 'hp0', customerId: null },
            { localId: 'p1', parentLocalId: null, type: 'Feature', title: 'Parent1', description: 'd', action: 'create', existingAdoId: null, sourceHash: 'hp1', customerId: null },
            { localId: 'a0', parentLocalId: 'p0', type: 'Requirement', title: 'A0', description: 'd', action: 'create', existingAdoId: null, sourceHash: 'ha0', customerId: null },
            { localId: 'a1', parentLocalId: 'p0', type: 'Requirement', title: 'A1', description: 'd', action: 'create', existingAdoId: null, sourceHash: 'ha1', customerId: null },
            { localId: 'b0', parentLocalId: 'p1', type: 'Requirement', title: 'B0', description: 'd', action: 'create', existingAdoId: null, sourceHash: 'hb0', customerId: null },
            { localId: 'b1', parentLocalId: 'p1', type: 'Requirement', title: 'B1', description: 'd', action: 'create', existingAdoId: null, sourceHash: 'hb1', customerId: null },
          ],
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      auditEntry: { create: jest.fn().mockResolvedValue(undefined) },
      createdItemMapping: { findMany: jest.fn().mockResolvedValue([]), upsert: jest.fn().mockResolvedValue(undefined), update: jest.fn().mockResolvedValue(undefined) },
    };
    const service = new JobsService(
      prisma as any,
      { createWorkItem, linkParentChild, discoverWorkItemTypeCategories: jest.fn().mockResolvedValue({ Epic: 'Epic', Feature: 'Feature', Requirement: 'Requirement' }) } as any,
      { record: jest.fn() } as any,
      { upsertDedupEntriesBatch: jest.fn().mockResolvedValue(undefined) } as any,
      'redis://unused',
      undefined,
      4,
    );

    const result = await service.confirm('job-1');

    expect(crossGroupOverlapDetected).toBe(true);
    expect(sameGroupOverlapDetected).toBe(false);
    expect(result).toEqual({ status: 'succeeded', createdCount: 6 });
  });

  it('stops a sibling group at its first failure instead of creating later siblings out of order', async () => {
    // Real edge case this locks in: without this, a mid-group failure let
    // the loop keep going and create LATER siblings anyway -- on retry,
    // only the failed one gets recreated (CreatedItemMapping already has
    // the others), landing it with a HIGHER System.Id than siblings that
    // come after it in document order. This test proves the tail is left
    // un-created (not partially created) when an earlier sibling fails.
    const createWorkItem = jest.fn()
      .mockResolvedValueOnce({ id: 100 }) // Parent
      .mockResolvedValueOnce({ id: 101 }) // Child 0 -- succeeds
      .mockRejectedValueOnce(new Error('ADO create failed')) // Child 1 -- fails
      .mockResolvedValueOnce({ id: 103 }); // Child 2 -- must NOT be reached
    const linkParentChild = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1', status: 'diff_ready', state: 'Proposed', areaPath: 'Project\\Area1',
          dryRunDiff: [
            { localId: 'p0', parentLocalId: null, type: 'Feature', title: 'Parent', description: 'd', action: 'create', existingAdoId: null, sourceHash: 'hp', customerId: null },
            { localId: 'n0', parentLocalId: 'p0', type: 'Requirement', title: 'Child 0', description: 'd0', action: 'create', existingAdoId: null, sourceHash: 'h0', customerId: null },
            { localId: 'n1', parentLocalId: 'p0', type: 'Requirement', title: 'Child 1', description: 'd1', action: 'create', existingAdoId: null, sourceHash: 'h1', customerId: null },
            { localId: 'n2', parentLocalId: 'p0', type: 'Requirement', title: 'Child 2', description: 'd2', action: 'create', existingAdoId: null, sourceHash: 'h2', customerId: null },
          ],
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      auditEntry: { create: jest.fn().mockResolvedValue(undefined) },
      createdItemMapping: { findMany: jest.fn().mockResolvedValue([]), upsert: jest.fn().mockResolvedValue(undefined), update: jest.fn().mockResolvedValue(undefined) },
    };
    const service = new JobsService(
      prisma as any,
      { createWorkItem, linkParentChild, discoverWorkItemTypeCategories: jest.fn().mockResolvedValue({ Epic: 'Epic', Feature: 'Feature', Requirement: 'Requirement' }) } as any,
      { record: jest.fn() } as any,
      { upsertDedupEntriesBatch: jest.fn().mockResolvedValue(undefined) } as any,
      'redis://unused',
      undefined,
      4,
    );

    await expect(service.confirm('job-1')).rejects.toThrow();

    // Child 2's create must never have been attempted -- only Parent,
    // Child 0, and the failing Child 1 call happened.
    expect(createWorkItem).toHaveBeenCalledTimes(3);
    const titlesCalled = createWorkItem.mock.calls.map((call) => (call[1] as Record<string, string>)['System.Title']);
    expect(titlesCalled).not.toContain('Child 2');
  });
});

describe('JobsService.cancel', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('throws not found for an unknown job', async () => {
    const prisma = { job: { findUnique: jest.fn().mockResolvedValue(null) } };
    const service = new JobsService(prisma as any, {} as any, { record: jest.fn() } as any, {} as any, 'redis://unused');

    await expect(service.cancel('unknown')).rejects.toThrow('not found');
  });

  it('throws a conflict when the job is not pending or running (e.g. already diff_ready)', async () => {
    const prisma = { job: { findUnique: jest.fn().mockResolvedValue({ id: 'job-1', status: 'diff_ready' }) } };
    const service = new JobsService(prisma as any, {} as any, { record: jest.fn() } as any, {} as any, 'redis://unused');

    await expect(service.cancel('job-1')).rejects.toThrow("cannot be cancelled from status 'diff_ready'");
  });

  it('removes the still-queued BullMQ job and marks the row cancelled when it has not been picked up yet', async () => {
    const prisma = {
      job: { findUnique: jest.fn().mockResolvedValue({ id: 'job-1', status: 'pending' }), update: jest.fn().mockResolvedValue(undefined) },
      auditEntry: { create: jest.fn().mockResolvedValue(undefined) },
    };
    const remove = jest.fn().mockResolvedValue(undefined);
    const getState = jest.fn().mockResolvedValue('waiting');
    jest.spyOn(Queue.prototype, 'getJob').mockResolvedValue({ getState, remove } as any);
    const service = new JobsService(prisma as any, {} as any, { record: jest.fn() } as any, {} as any, 'redis://unused');

    const result = await service.cancel('job-1');

    expect(remove).toHaveBeenCalled();
    expect(prisma.job.update).toHaveBeenCalledWith({ where: { id: 'job-1' }, data: { status: 'cancelled' } });
    expect(prisma.auditEntry.create).toHaveBeenCalledWith({ data: { jobId: 'job-1', message: 'Job cancelled by user' } });
    expect(result).toEqual({ status: 'cancelled' });
  });

  it('does not try to remove an already-active BullMQ job, but still marks the row cancelled', async () => {
    const prisma = {
      job: { findUnique: jest.fn().mockResolvedValue({ id: 'job-1', status: 'running' }), update: jest.fn().mockResolvedValue(undefined) },
      auditEntry: { create: jest.fn().mockResolvedValue(undefined) },
    };
    const remove = jest.fn().mockResolvedValue(undefined);
    const getState = jest.fn().mockResolvedValue('active');
    jest.spyOn(Queue.prototype, 'getJob').mockResolvedValue({ getState, remove } as any);
    const service = new JobsService(prisma as any, {} as any, { record: jest.fn() } as any, {} as any, 'redis://unused');

    const result = await service.cancel('job-1');

    expect(remove).not.toHaveBeenCalled();
    expect(prisma.job.update).toHaveBeenCalledWith({ where: { id: 'job-1' }, data: { status: 'cancelled' } });
    expect(result).toEqual({ status: 'cancelled' });
  });

  it('still marks the row cancelled when the BullMQ job is already gone (race with completion)', async () => {
    const prisma = {
      job: { findUnique: jest.fn().mockResolvedValue({ id: 'job-1', status: 'running' }), update: jest.fn().mockResolvedValue(undefined) },
      auditEntry: { create: jest.fn().mockResolvedValue(undefined) },
    };
    jest.spyOn(Queue.prototype, 'getJob').mockResolvedValue(undefined);
    const service = new JobsService(prisma as any, {} as any, { record: jest.fn() } as any, {} as any, 'redis://unused');

    const result = await service.cancel('job-1');

    expect(prisma.job.update).toHaveBeenCalledWith({ where: { id: 'job-1' }, data: { status: 'cancelled' } });
    expect(result).toEqual({ status: 'cancelled' });
  });

  it('writes a caller-supplied reason instead of the default "cancelled by user" message', async () => {
    // StaleJobWatchdogService's own use of this method -- an automatic
    // stall-cancellation must never falsely read as "by user".
    const prisma = {
      job: { findUnique: jest.fn().mockResolvedValue({ id: 'job-1', status: 'running' }), update: jest.fn().mockResolvedValue(undefined) },
      auditEntry: { create: jest.fn().mockResolvedValue(undefined) },
    };
    jest.spyOn(Queue.prototype, 'getJob').mockResolvedValue(undefined);
    const service = new JobsService(prisma as any, {} as any, { record: jest.fn() } as any, {} as any, 'redis://unused');

    await service.cancel('job-1', 'Automatically cancelled -- no activity detected for over 60 minutes.');

    expect(prisma.auditEntry.create).toHaveBeenCalledWith({
      data: { jobId: 'job-1', message: 'Automatically cancelled -- no activity detected for over 60 minutes.' },
    });
  });
});

describe('JobsService.delete', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('throws not found for an unknown job', async () => {
    const prisma = { job: { findUnique: jest.fn().mockResolvedValue(null) } };
    const service = new JobsService(prisma as any, {} as any, { record: jest.fn() } as any, {} as any, 'redis://unused');

    await expect(service.delete('unknown')).rejects.toThrow('not found');
  });

  it.each(['pending', 'running', 'writing'])('throws a conflict when the job is %s', async (status) => {
    const prisma = { job: { findUnique: jest.fn().mockResolvedValue({ id: 'job-1', status }) } };
    const service = new JobsService(prisma as any, {} as any, { record: jest.fn() } as any, {} as any, 'redis://unused');

    await expect(service.delete('job-1')).rejects.toThrow(`cannot be deleted while '${status}'`);
  });

  it.each(['diff_ready', 'succeeded', 'failed', 'rejected', 'cancelled'])(
    'deletes a %s job and every child row in one transaction, but never touches IdempotencyMapping',
    async (status) => {
      const chatMessageDeleteMany = jest.fn().mockResolvedValue(undefined);
      const createdItemMappingDeleteMany = jest.fn().mockResolvedValue(undefined);
      const dedupSkipAuditDeleteMany = jest.fn().mockResolvedValue(undefined);
      const auditEntryDeleteMany = jest.fn().mockResolvedValue(undefined);
      const jobSourceFileDeleteMany = jest.fn().mockResolvedValue(undefined);
      const jobFigureFileDeleteMany = jest.fn().mockResolvedValue(undefined);
      const jobEventDeleteMany = jest.fn().mockResolvedValue(undefined);
      const jobDelete = jest.fn().mockResolvedValue(undefined);
      const prisma = {
        job: { findUnique: jest.fn().mockResolvedValue({ id: 'job-1', status }), delete: jobDelete },
        chatMessage: { deleteMany: chatMessageDeleteMany },
        createdItemMapping: { deleteMany: createdItemMappingDeleteMany },
        dedupSkipAudit: { deleteMany: dedupSkipAuditDeleteMany },
        auditEntry: { deleteMany: auditEntryDeleteMany },
        jobSourceFile: { deleteMany: jobSourceFileDeleteMany },
        jobFigureFile: { deleteMany: jobFigureFileDeleteMany },
        jobEvent: { deleteMany: jobEventDeleteMany },
        idempotencyMapping: { deleteMany: jest.fn() },
        $transaction: jest.fn(async (ops: unknown[]) => Promise.all(ops)),
      };
      const service = new JobsService(prisma as any, {} as any, { record: jest.fn() } as any, {} as any, 'redis://unused');

      const result = await service.delete('job-1');

      expect(chatMessageDeleteMany).toHaveBeenCalledWith({ where: { jobId: 'job-1' } });
      expect(createdItemMappingDeleteMany).toHaveBeenCalledWith({ where: { jobId: 'job-1' } });
      expect(dedupSkipAuditDeleteMany).toHaveBeenCalledWith({ where: { jobId: 'job-1' } });
      expect(auditEntryDeleteMany).toHaveBeenCalledWith({ where: { jobId: 'job-1' } });
      expect(jobSourceFileDeleteMany).toHaveBeenCalledWith({ where: { jobId: 'job-1' } });
      expect(jobFigureFileDeleteMany).toHaveBeenCalledWith({ where: { jobId: 'job-1' } });
      // Real bug (user-reported): JobEvent has a required FK to Job with no
      // onDelete: Cascade -- was the only child table missing from this
      // transaction, so job.delete() unconditionally hit a foreign key
      // violation for every job that ever emitted a narration event (i.e.
      // every job that actually ran).
      expect(jobEventDeleteMany).toHaveBeenCalledWith({ where: { jobId: 'job-1' } });
      expect(jobDelete).toHaveBeenCalledWith({ where: { id: 'job-1' } });
      expect(prisma.idempotencyMapping.deleteMany).not.toHaveBeenCalled();
      expect(result).toEqual({ deleted: true });
    },
  );
});

describe('JobsService.storeFigureFile', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('upserts a JobFigureFile row keyed by (jobId, figureId)', async () => {
    const jobFigureFileUpsert = jest.fn().mockResolvedValue(undefined);
    const prisma = { jobFigureFile: { upsert: jobFigureFileUpsert } };
    const service = new JobsService(prisma as any, {} as any, { record: jest.fn() } as any, {} as any, 'redis://unused');

    const bytes = Buffer.from('png bytes');
    await service.storeFigureFile('job-1', 'f3', bytes, 'image/png');

    expect(jobFigureFileUpsert).toHaveBeenCalledWith({
      where: { jobId_figureId: { jobId: 'job-1', figureId: 'f3' } },
      create: { jobId: 'job-1', figureId: 'f3', bytes, mimeType: 'image/png' },
      update: { bytes, mimeType: 'image/png' },
    });
  });
});

describe('JobsService.getFigureFile', () => {
  it('returns bytes/mimeType for a stored figure', async () => {
    const prisma = {
      jobFigureFile: {
        findUnique: jest.fn().mockResolvedValue({ id: 'jff-1', jobId: 'job-1', figureId: 'f0', bytes: Buffer.from('png bytes'), mimeType: 'image/png' }),
      },
    };
    const service = new JobsService(prisma as any, {} as any, { record: jest.fn() } as any, {} as any, 'redis://unused');

    const result = await service.getFigureFile('job-1', 'f0');

    expect(prisma.jobFigureFile.findUnique).toHaveBeenCalledWith({ where: { jobId_figureId: { jobId: 'job-1', figureId: 'f0' } } });
    expect(result).toEqual({ bytes: Buffer.from('png bytes'), mimeType: 'image/png' });
  });

  it('returns null (not a thrown error) when the figure was never stored or already attached', async () => {
    const prisma = { jobFigureFile: { findUnique: jest.fn().mockResolvedValue(null) } };
    const service = new JobsService(prisma as any, {} as any, { record: jest.fn() } as any, {} as any, 'redis://unused');

    const result = await service.getFigureFile('job-1', 'f0');

    expect(result).toBeNull();
  });
});

describe('JobsService.attachFigureToAdo', () => {
  it('attaches using existingAdoId for a reuse entry and deletes the JobFigureFile row on success', async () => {
    const uploadAttachment = jest.fn().mockResolvedValue(undefined);
    const figureFileDelete = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1',
          dryRunDiff: [
            { localId: 'n0', parentLocalId: null, type: 'Requirement', title: 'Req', description: 'd0', action: 'reuse', existingAdoId: 555, sourceHash: 'h0', customerId: null },
          ],
        }),
      },
      jobFigureFile: {
        findUnique: jest.fn().mockResolvedValue({ id: 'jff-1', jobId: 'job-1', figureId: 'f0', bytes: Buffer.from('png bytes'), mimeType: 'image/png' }),
        delete: figureFileDelete,
      },
    };
    const service = new JobsService(prisma as any, { uploadAttachment } as any, { record: jest.fn() } as any, {} as any, 'redis://unused');

    const result = await service.attachFigureToAdo('job-1', 'n0', 'f0', { orgUrl: 'https://ado.example', pat: 'x' });

    expect(uploadAttachment).toHaveBeenCalledWith(555, 'f0.png', Buffer.from('png bytes').toString('base64'), 'image/png', { orgUrl: 'https://ado.example', pat: 'x' });
    expect(figureFileDelete).toHaveBeenCalledWith({ where: { id: 'jff-1' } });
    expect(result).toEqual({ attached: true, adoId: 555 });
  });

  it('attaches using existingAdoId for a dedup_skip entry', async () => {
    const uploadAttachment = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1',
          dryRunDiff: [
            { localId: 'n0', parentLocalId: null, type: 'Requirement', title: 'Req', description: 'd0', action: 'dedup_skip', existingAdoId: 777, sourceHash: 'h0', customerId: null },
          ],
        }),
      },
      jobFigureFile: {
        findUnique: jest.fn().mockResolvedValue({ id: 'jff-1', jobId: 'job-1', figureId: 'f0', bytes: Buffer.from('png bytes'), mimeType: 'image/png' }),
        delete: jest.fn().mockResolvedValue(undefined),
      },
    };
    const service = new JobsService(prisma as any, { uploadAttachment } as any, { record: jest.fn() } as any, {} as any, 'redis://unused');

    const result = await service.attachFigureToAdo('job-1', 'n0', 'f0');

    expect(uploadAttachment).toHaveBeenCalledWith(777, 'f0.png', expect.any(String), 'image/png', undefined);
    expect(result.adoId).toBe(777);
  });

  it('falls back to CreatedItemMapping for a "create" entry (post-confirm)', async () => {
    const uploadAttachment = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1',
          dryRunDiff: [
            { localId: 'n0', parentLocalId: null, type: 'Requirement', title: 'Req', description: 'd0', action: 'create', existingAdoId: null, sourceHash: 'h0', customerId: null },
          ],
        }),
      },
      createdItemMapping: { findUnique: jest.fn().mockResolvedValue({ jobId: 'job-1', localId: 'n0', adoWorkItemId: 321, linked: true }) },
      jobFigureFile: {
        findUnique: jest.fn().mockResolvedValue({ id: 'jff-1', jobId: 'job-1', figureId: 'f0', bytes: Buffer.from('png bytes'), mimeType: 'image/png' }),
        delete: jest.fn().mockResolvedValue(undefined),
      },
    };
    const service = new JobsService(prisma as any, { uploadAttachment } as any, { record: jest.fn() } as any, {} as any, 'redis://unused');

    const result = await service.attachFigureToAdo('job-1', 'n0', 'f0');

    expect(prisma.createdItemMapping.findUnique).toHaveBeenCalledWith({ where: { jobId_localId: { jobId: 'job-1', localId: 'n0' } } });
    expect(uploadAttachment).toHaveBeenCalledWith(321, 'f0.png', expect.any(String), 'image/png', undefined);
    expect(result.adoId).toBe(321);
  });

  it('throws BadRequestException when the entry has no resolved ADO id yet', async () => {
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1',
          dryRunDiff: [
            { localId: 'n0', parentLocalId: null, type: 'Requirement', title: 'Req', description: 'd0', action: 'create', existingAdoId: null, sourceHash: 'h0', customerId: null },
          ],
        }),
      },
      createdItemMapping: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    const service = new JobsService(prisma as any, { uploadAttachment: jest.fn() } as any, { record: jest.fn() } as any, {} as any, 'redis://unused');

    await expect(service.attachFigureToAdo('job-1', 'n0', 'f0')).rejects.toThrow('no resolved ADO work item id yet');
  });

  it('throws NotFoundException when the job does not exist', async () => {
    const prisma = { job: { findUnique: jest.fn().mockResolvedValue(null) } };
    const service = new JobsService(prisma as any, {} as any, { record: jest.fn() } as any, {} as any, 'redis://unused');

    await expect(service.attachFigureToAdo('missing', 'n0', 'f0')).rejects.toThrow('not found');
  });

  it('throws NotFoundException when the diff entry does not exist', async () => {
    const prisma = { job: { findUnique: jest.fn().mockResolvedValue({ id: 'job-1', dryRunDiff: [] }) } };
    const service = new JobsService(prisma as any, {} as any, { record: jest.fn() } as any, {} as any, 'redis://unused');

    await expect(service.attachFigureToAdo('job-1', 'missing-local-id', 'f0')).rejects.toThrow('not found');
  });

  it('throws NotFoundException when the figure was never stored or already attached', async () => {
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1',
          dryRunDiff: [
            { localId: 'n0', parentLocalId: null, type: 'Requirement', title: 'Req', description: 'd0', action: 'reuse', existingAdoId: 555, sourceHash: 'h0', customerId: null },
          ],
        }),
      },
      jobFigureFile: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    const service = new JobsService(prisma as any, { uploadAttachment: jest.fn() } as any, { record: jest.fn() } as any, {} as any, 'redis://unused');

    await expect(service.attachFigureToAdo('job-1', 'n0', 'f0')).rejects.toThrow('not found');
  });
});

describe('JobsService.submit', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('persists the uploaded bytes as a JobSourceFile row when under the size cap', async () => {
    jest.spyOn(Queue.prototype, 'add').mockResolvedValue(undefined as any);
    const jobSourceFileCreate = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      job: { create: jest.fn().mockResolvedValue({ id: 'job-1' }) },
      auditEntry: { create: jest.fn().mockResolvedValue(undefined) },
      jobSourceFile: { create: jobSourceFileCreate },
    };
    const service = new JobsService(
      prisma as any, {} as any, { record: jest.fn() } as any, {} as any, 'redis://unused',
      undefined, undefined, undefined, 1000, // maxStoredSourceBytes
    );

    await service.submit({
      areaPath: 'Project\\Area1', userId: null, customerId: null, mode: 'baseline',
      fileBuffer: Buffer.from('small file'), filename: 'doc.txt', sourceHash: 'hash-1',
    });

    expect(jobSourceFileCreate).toHaveBeenCalledWith({ data: { jobId: 'job-1', bytes: Buffer.from('small file') } });
  });

  it('does not persist bytes over the size cap', async () => {
    jest.spyOn(Queue.prototype, 'add').mockResolvedValue(undefined as any);
    const jobSourceFileCreate = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      job: { create: jest.fn().mockResolvedValue({ id: 'job-1' }) },
      auditEntry: { create: jest.fn().mockResolvedValue(undefined) },
      jobSourceFile: { create: jobSourceFileCreate },
    };
    const service = new JobsService(
      prisma as any, {} as any, { record: jest.fn() } as any, {} as any, 'redis://unused',
      undefined, undefined, undefined, 5, // maxStoredSourceBytes -- smaller than the test buffer
    );

    await service.submit({
      areaPath: 'Project\\Area1', userId: null, customerId: null, mode: 'baseline',
      fileBuffer: Buffer.from('a file bigger than 5 bytes'), filename: 'doc.txt', sourceHash: 'hash-1',
    });

    expect(jobSourceFileCreate).not.toHaveBeenCalled();
  });

  it('does not fail submit when persisting the source file throws (best-effort retention)', async () => {
    jest.spyOn(Queue.prototype, 'add').mockResolvedValue(undefined as any);
    const prisma = {
      job: { create: jest.fn().mockResolvedValue({ id: 'job-1' }) },
      auditEntry: { create: jest.fn().mockResolvedValue(undefined) },
      jobSourceFile: { create: jest.fn().mockRejectedValue(new Error('disk full')) },
    };
    const service = new JobsService(prisma as any, {} as any, { record: jest.fn() } as any, {} as any, 'redis://unused');

    const result = await service.submit({
      areaPath: 'Project\\Area1', userId: null, customerId: null, mode: 'baseline',
      fileBuffer: Buffer.from('small file'), filename: 'doc.txt', sourceHash: 'hash-1',
    });

    expect(result).toEqual({ jobId: 'job-1' });
  });
});

describe('JobsService.resubmit', () => {
  it('throws not found for an unknown job', async () => {
    const prisma = { job: { findUnique: jest.fn().mockResolvedValue(null) } };
    const service = new JobsService(prisma as any, {} as any, { record: jest.fn() } as any, {} as any, 'redis://unused');

    await expect(service.resubmit('unknown')).rejects.toThrow('not found');
  });

  it('throws not found when the job has no retained source file', async () => {
    const prisma = {
      job: { findUnique: jest.fn().mockResolvedValue({ id: 'job-1' }) },
      jobSourceFile: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    const service = new JobsService(prisma as any, {} as any, { record: jest.fn() } as any, {} as any, 'redis://unused');

    await expect(service.resubmit('job-1')).rejects.toThrow('no retained source file');
  });

  it('creates a new job with the original config and bytes, without mutating the source job', async () => {
    jest.spyOn(Queue.prototype, 'add').mockResolvedValue(undefined as any);
    const jobCreate = jest.fn().mockResolvedValue({ id: 'job-2' });
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1', areaPath: 'Project\\Area1', userId: 'user-1', customerId: 'CUST-1', mode: 'survey',
          followUp: true, originalFilename: 'doc.txt', sourceHash: 'hash-1', state: 'Approved', iterationPath: 'Iter\\1',
        }),
        create: jobCreate,
      },
      jobSourceFile: { findUnique: jest.fn().mockResolvedValue({ jobId: 'job-1', bytes: Buffer.from('original bytes') }) },
      auditEntry: { create: jest.fn().mockResolvedValue(undefined) },
    };
    const service = new JobsService(prisma as any, {} as any, { record: jest.fn() } as any, {} as any, 'redis://unused');

    const result = await service.resubmit('job-1');

    expect(jobCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        areaPath: 'Project\\Area1', userId: 'user-1', customerId: 'CUST-1', mode: 'survey',
        followUp: true, state: 'Approved', iterationPath: 'Iter\\1', originalFilename: 'doc.txt', sourceHash: 'hash-1',
      }),
    });
    expect(result).toEqual({ jobId: 'job-2' });
  });
});

describe('JobsService.list', () => {
  it('lists jobs newest-first with item counts derived from dryRunDiff length and real created-item counts', async () => {
    const prisma = {
      job: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'j2',
            mode: 'survey',
            status: 'diff_ready',
            areaPath: 'Proj\\B',
            originalFilename: 'b.docx',
            dryRunDiff: [{}, {}, {}],
            createdAt: new Date('2026-07-09T10:00:00Z'),
            _count: { createdItemMappings: 0 },
          },
          {
            id: 'j1',
            mode: 'baseline',
            status: 'succeeded',
            areaPath: 'Proj\\A',
            originalFilename: 'a.docx',
            dryRunDiff: [{}],
            createdAt: new Date('2026-07-08T10:00:00Z'),
            _count: { createdItemMappings: 1 },
          },
        ]),
      },
    };
    const service = new JobsService(prisma as any, {} as any, { record: jest.fn() } as any, {} as any, 'redis://unused');

    const result = await service.list();

    expect(prisma.job.findMany).toHaveBeenCalledWith(expect.objectContaining({ orderBy: { createdAt: 'desc' } }));
    expect(result).toEqual([
      { id: 'j2', mode: 'survey', status: 'diff_ready', areaPath: 'Proj\\B', originalFilename: 'b.docx', itemCount: 3, createdItemCount: 0, createdAt: new Date('2026-07-09T10:00:00Z') },
      { id: 'j1', mode: 'baseline', status: 'succeeded', areaPath: 'Proj\\A', originalFilename: 'a.docx', itemCount: 1, createdItemCount: 1, createdAt: new Date('2026-07-08T10:00:00Z') },
    ]);
  });

  it('scopes the query to userId when provided -- ownership, matching every per-job route', async () => {
    const prisma = { job: { findMany: jest.fn().mockResolvedValue([]) } };
    const service = new JobsService(prisma as any, {} as any, { record: jest.fn() } as any, {} as any, 'redis://unused');

    await service.list('user-1');

    expect(prisma.job.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 'user-1' } }));
  });

  it('queries all jobs (no where filter) when userId is omitted', async () => {
    const prisma = { job: { findMany: jest.fn().mockResolvedValue([]) } };
    const service = new JobsService(prisma as any, {} as any, { record: jest.fn() } as any, {} as any, 'redis://unused');

    await service.list();

    expect(prisma.job.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: {} }));
  });
});

describe('JobsService.getById', () => {
  it('returns kbCitations alongside the existing job fields', async () => {
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1',
          status: 'diff_ready',
          mode: 'survey',
          dryRunDiff: [{ localId: 'n0' }],
          warnings: null,
          kbCitations: ['doc-a.docx'],
          figureDescriptions: null,
        }),
      },
    };
    const service = new JobsService(prisma as any, {} as any, {} as any, {} as any, 'redis://unused');

    const result = await service.getById('job-1');

    expect(result).toEqual({
      id: 'job-1',
      status: 'diff_ready',
      mode: 'survey',
      dryRunDiff: [{ localId: 'n0' }],
      warnings: [],
      kbCitations: ['doc-a.docx'],
      // A historical job predates the figureDescriptions column -- a null
      // column defaults to [], same convention as warnings above.
      figureDescriptions: [],
      // A historical job predates the tableDescriptions column entirely
      // (absent from the mocked row) -- defaults to [], same convention as
      // figureDescriptions above.
      tableDescriptions: [],
      // A historical job predates the excludedFigureIds/excludedTableIds
      // columns entirely (absent from the mocked row) -- defaults to [],
      // same convention as figureDescriptions above.
      excludedFigureIds: [],
      excludedTableIds: [],
    });
  });

  it('returns persisted excludedFigureIds/excludedTableIds when the columns have real data', async () => {
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1',
          status: 'diff_ready',
          mode: 'survey',
          dryRunDiff: [],
          warnings: null,
          kbCitations: [],
          figureDescriptions: [],
          excludedFigureIds: ['fig-1', 'fig-2'],
          excludedTableIds: ['tbl-1'],
        }),
      },
    };
    const service = new JobsService(prisma as any, {} as any, {} as any, {} as any, 'redis://unused');

    const result = await service.getById('job-1');

    expect(result?.excludedFigureIds).toEqual(['fig-1', 'fig-2']);
    expect(result?.excludedTableIds).toEqual(['tbl-1']);
  });

  it('returns persisted figureDescriptions when the column has real data', async () => {
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1',
          status: 'diff_ready',
          mode: 'survey',
          dryRunDiff: [],
          warnings: null,
          kbCitations: [],
          figureDescriptions: [{ figureIndex: 1, caption: 'A block diagram.' }],
        }),
      },
    };
    const service = new JobsService(prisma as any, {} as any, {} as any, {} as any, 'redis://unused');

    const result = await service.getById('job-1');

    expect(result?.figureDescriptions).toEqual([{ figureIndex: 1, caption: 'A block diagram.' }]);
  });

  it('returns null for an unknown job', async () => {
    const prisma = { job: { findUnique: jest.fn().mockResolvedValue(null) } };
    const service = new JobsService(prisma as any, {} as any, {} as any, {} as any, 'redis://unused');

    expect(await service.getById('missing')).toBeNull();
  });
});
