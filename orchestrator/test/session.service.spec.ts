import { SessionService } from '../src/modules/auth/session.service';

// In-memory fake standing in for Prisma's `session` model -- only the
// shape SessionService actually touches (create/findUnique/deleteMany).
function makeFakePrisma() {
  const rows: { tokenHash: string; userId: string; displayName: string; expiresAt: Date }[] = [];
  return {
    rows,
    session: {
      create: jest.fn(async ({ data }: { data: { tokenHash: string; userId: string; displayName: string; expiresAt: Date } }) => {
        rows.push(data);
        return data;
      }),
      findUnique: jest.fn(async ({ where }: { where: { tokenHash: string } }) => rows.find((r) => r.tokenHash === where.tokenHash) ?? null),
      deleteMany: jest.fn(async ({ where }: { where: { tokenHash: string } }) => {
        const before = rows.length;
        const remaining = rows.filter((r) => r.tokenHash !== where.tokenHash);
        rows.length = 0;
        rows.push(...remaining);
        return { count: before - rows.length };
      }),
    },
  };
}

describe('SessionService', () => {
  it('create() then validate() round-trips the same identity for the raw token', async () => {
    const prisma = makeFakePrisma();
    const service = new SessionService(prisma as any);

    const token = await service.create('user-1', 'Jane Doe');
    const user = await service.validate(token);

    expect(user).toEqual({ userId: 'user-1', displayName: 'Jane Doe' });
  });

  it('never persists the raw token -- only its hash is stored', async () => {
    const prisma = makeFakePrisma();
    const service = new SessionService(prisma as any);

    const token = await service.create('user-1', 'Jane Doe');

    expect(prisma.rows).toHaveLength(1);
    expect(prisma.rows[0].tokenHash).not.toBe(token);
    expect(prisma.rows[0].tokenHash).toMatch(/^[0-9a-f]{64}$/); // sha256 hex digest
  });

  it('validate() returns null for a token that was never issued', async () => {
    const prisma = makeFakePrisma();
    const service = new SessionService(prisma as any);

    expect(await service.validate('never-issued-token')).toBeNull();
  });

  it('validate() returns null for an expired session', async () => {
    const prisma = makeFakePrisma();
    const service = new SessionService(prisma as any);
    const token = await service.create('user-1', 'Jane Doe');
    prisma.rows[0].expiresAt = new Date(Date.now() - 1000);

    expect(await service.validate(token)).toBeNull();
  });

  it('revoke() deletes the session so a subsequent validate() returns null -- real revocation, not a TTL wait', async () => {
    const prisma = makeFakePrisma();
    const service = new SessionService(prisma as any);
    const token = await service.create('user-1', 'Jane Doe');

    await service.revoke(token);

    expect(await service.validate(token)).toBeNull();
  });

  it('revoke() on an unknown token is a no-op, not an error', async () => {
    const prisma = makeFakePrisma();
    const service = new SessionService(prisma as any);

    await expect(service.revoke('never-issued-token')).resolves.toBeUndefined();
  });
});
