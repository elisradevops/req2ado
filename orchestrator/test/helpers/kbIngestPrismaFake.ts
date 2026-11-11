/**
 * An in-memory stand-in for the two Prisma models behind the knowledge-base batch ingest (KbIngestBatch, KbIngestBatchItem).
 *
 * The batch service and runner are mostly state transitions over rows ("claim the next queued file", "pause the batch",
 * "requeue what was running when the process died"), and a pile of hand-written jest.fn() mocks cannot tell whether a
 * sequence of those ends in the right state. This fake keeps real rows, so a test can run the runner for a few ticks and
 * look at the table.
 *
 * Deliberately narrow, like prismaMock.ts: only the operations the batch code uses, plain-field filters (no relation
 * filters), and anything else throws, so a new query shape fails loudly instead of quietly matching nothing.
 * Test-only. Never import this from `src/`.
 */

type Row = Record<string, any>;
type Where = Record<string, any>;

const ITEM_DEFAULTS: Row = {
  attempts: 0,
  nextAttemptAt: null,
  leaseUntil: null,
  errorKind: null,
  reason: null,
  chunksStored: null,
  chunksInStore: null,
  ingestedDocumentId: null,
  startedAt: null,
  finishedAt: null,
};

const BATCH_DEFAULTS: Row = {
  folderItemId: null,
  docType: null,
  pauseReason: null,
  cancelRequestedAt: null,
  profileScheduledAt: null,
  version: 0,
  startedAt: null,
  finishedAt: null,
};

function isDate(value: unknown): value is Date {
  return value instanceof Date;
}

function comparable(value: unknown): number | string {
  return isDate(value) ? value.getTime() : (value as number | string);
}

function matchesField(actual: unknown, condition: unknown): boolean {
  const value = actual === undefined ? null : actual;
  if (condition === null || typeof condition !== 'object' || isDate(condition)) {
    return isDate(value) && isDate(condition) ? value.getTime() === condition.getTime() : value === (condition === undefined ? null : condition);
  }
  const ops = condition as Record<string, any>;
  for (const [op, expected] of Object.entries(ops)) {
    switch (op) {
      case 'equals':
        if (!matchesField(value, expected)) return false;
        break;
      case 'in':
        if (!(expected as unknown[]).some((candidate) => matchesField(value, candidate))) return false;
        break;
      case 'notIn':
        if ((expected as unknown[]).some((candidate) => matchesField(value, candidate))) return false;
        break;
      case 'not':
        if (matchesField(value, expected)) return false;
        break;
      case 'lt':
        if (value === null || !(comparable(value) < comparable(expected))) return false;
        break;
      case 'lte':
        if (value === null || !(comparable(value) <= comparable(expected))) return false;
        break;
      case 'gt':
        if (value === null || !(comparable(value) > comparable(expected))) return false;
        break;
      case 'gte':
        if (value === null || !(comparable(value) >= comparable(expected))) return false;
        break;
      default:
        throw new Error(`kbIngestPrismaFake: unsupported filter operator "${op}"`);
    }
  }
  return true;
}

function matches(row: Row, where: Where | undefined): boolean {
  if (!where) return true;
  for (const [key, condition] of Object.entries(where)) {
    if (key === 'AND') {
      if (!(Array.isArray(condition) ? condition : [condition]).every((w: Where) => matches(row, w))) return false;
    } else if (key === 'OR') {
      if (!(condition as Where[]).some((w) => matches(row, w))) return false;
    } else if (key === 'NOT') {
      if ((Array.isArray(condition) ? condition : [condition]).some((w: Where) => matches(row, w))) return false;
    } else if (!matchesField(row[key], condition)) {
      return false;
    }
  }
  return true;
}

function applyData(row: Row, data: Row): void {
  for (const [key, value] of Object.entries(data)) {
    if (value !== null && typeof value === 'object' && !isDate(value) && 'increment' in value) {
      row[key] = (row[key] ?? 0) + (value as { increment: number }).increment;
    } else if (value !== undefined) {
      row[key] = value;
    }
  }
}

function sortRows(rows: Row[], orderBy: Row | Row[] | undefined): Row[] {
  if (!orderBy) return rows;
  const keys = (Array.isArray(orderBy) ? orderBy : [orderBy]).flatMap((entry) => Object.entries(entry) as [string, 'asc' | 'desc'][]);
  return [...rows].sort((a, b) => {
    for (const [key, direction] of keys) {
      const left = a[key] === null || a[key] === undefined ? Infinity : comparable(a[key]);
      const right = b[key] === null || b[key] === undefined ? Infinity : comparable(b[key]);
      if (left === right) continue;
      return (left < right ? -1 : 1) * (direction === 'desc' ? -1 : 1);
    }
    return 0;
  });
}

export interface KbIngestPrismaFake {
  kbIngestBatch: ModelFake;
  kbIngestBatchItem: ModelFake;
  $transaction: <T>(work: ((tx: KbIngestPrismaFake) => Promise<T>) | Promise<unknown>[]) => Promise<T | unknown[]>;
  /** The rows as they are now (copies), for assertions. */
  batches: () => Row[];
  items: () => Row[];
  /** Replaces a clock the fake uses for `createdAt`. */
  setNow: (now: Date) => void;
}

interface ModelFake {
  create: (args: { data: Row }) => Promise<Row>;
  createMany: (args: { data: Row[] }) => Promise<{ count: number }>;
  findFirst: (args?: { where?: Where; orderBy?: Row | Row[] }) => Promise<Row | null>;
  findUnique: (args: { where: Where }) => Promise<Row | null>;
  findMany: (args?: { where?: Where; orderBy?: Row | Row[]; take?: number }) => Promise<Row[]>;
  update: (args: { where: Where; data: Row }) => Promise<Row>;
  updateMany: (args: { where?: Where; data: Row }) => Promise<{ count: number }>;
  deleteMany: (args?: { where?: Where }) => Promise<{ count: number }>;
  count: (args?: { where?: Where }) => Promise<number>;
}

export function makeKbIngestPrismaFake(initial: { batches?: Row[]; items?: Row[] } = {}): KbIngestPrismaFake {
  let clock = new Date('2026-11-12T09:00:00.000Z');
  let sequence = 0;
  const tables: Record<'kbIngestBatch' | 'kbIngestBatchItem', Row[]> = {
    kbIngestBatch: (initial.batches ?? []).map((row) => ({ ...BATCH_DEFAULTS, createdAt: clock, ...row })),
    kbIngestBatchItem: (initial.items ?? []).map((row) => ({ ...ITEM_DEFAULTS, ...row })),
  };
  const defaultsFor = (table: keyof typeof tables): Row => (table === 'kbIngestBatch' ? BATCH_DEFAULTS : ITEM_DEFAULTS);

  function model(table: keyof typeof tables): ModelFake {
    const rows = tables[table];
    const build = (data: Row): Row => ({ id: `${table}-${++sequence}`, ...(table === 'kbIngestBatch' ? { createdAt: clock } : {}), ...defaultsFor(table), ...data });
    return {
      create: async ({ data }) => {
        const row = build(data);
        if (table === 'kbIngestBatchItem' && rows.some((r) => r.batchId === row.batchId && r.itemId === row.itemId)) {
          throw new Error('Unique constraint failed on (batchId, itemId)');
        }
        rows.push(row);
        return { ...row };
      },
      createMany: async ({ data }) => {
        for (const entry of data) {
          const row = build(entry);
          if (table === 'kbIngestBatchItem' && rows.some((r) => r.batchId === row.batchId && r.itemId === row.itemId)) {
            throw new Error('Unique constraint failed on (batchId, itemId)');
          }
          rows.push(row);
        }
        return { count: data.length };
      },
      findFirst: async (args = {}) => {
        const found = sortRows(rows.filter((row) => matches(row, args.where)), args.orderBy)[0];
        return found ? { ...found } : null;
      },
      findUnique: async ({ where }) => {
        const found = rows.find((row) => matches(row, where));
        return found ? { ...found } : null;
      },
      findMany: async (args = {}) => {
        const found = sortRows(rows.filter((row) => matches(row, args.where)), args.orderBy);
        return (args.take === undefined ? found : found.slice(0, args.take)).map((row) => ({ ...row }));
      },
      update: async ({ where, data }) => {
        const row = rows.find((r) => matches(r, where));
        if (!row) throw new Error('Record to update not found.');
        applyData(row, data);
        return { ...row };
      },
      updateMany: async ({ where, data }) => {
        const targets = rows.filter((row) => matches(row, where));
        for (const row of targets) applyData(row, data);
        return { count: targets.length };
      },
      deleteMany: async ({ where } = {}) => {
        const doomed = rows.filter((row) => matches(row, where));
        for (const row of doomed) rows.splice(rows.indexOf(row), 1);
        if (table === 'kbIngestBatch') {
          // onDelete: Cascade
          const ids = new Set(doomed.map((row) => row.id));
          const items = tables.kbIngestBatchItem;
          for (let index = items.length - 1; index >= 0; index--) {
            if (ids.has(items[index].batchId)) items.splice(index, 1);
          }
        }
        return { count: doomed.length };
      },
      count: async ({ where } = {}) => rows.filter((row) => matches(row, where)).length,
    };
  }

  const fake: KbIngestPrismaFake = {
    kbIngestBatch: model('kbIngestBatch'),
    kbIngestBatchItem: model('kbIngestBatchItem'),
    $transaction: (async (work: unknown) => {
      if (typeof work === 'function') return (work as (tx: KbIngestPrismaFake) => Promise<unknown>)(fake);
      return Promise.all(work as Promise<unknown>[]);
    }) as KbIngestPrismaFake['$transaction'],
    batches: () => tables.kbIngestBatch.map((row) => ({ ...row })),
    items: () => tables.kbIngestBatchItem.map((row) => ({ ...row })),
    setNow: (now) => {
      clock = now;
    },
  };
  return fake;
}
