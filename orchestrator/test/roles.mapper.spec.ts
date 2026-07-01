import { toDomainRole, Role } from '../src/modules/auth/roles.enum';

describe('toDomainRole', () => {
  it('maps Prisma ADMIN to Role.Admin', () => {
    expect(toDomainRole('ADMIN')).toBe(Role.Admin);
  });

  it('maps Prisma OPERATOR to Role.Operator', () => {
    expect(toDomainRole('OPERATOR')).toBe(Role.Operator);
  });

  it('maps Prisma VIEWER to Role.Viewer', () => {
    expect(toDomainRole('VIEWER')).toBe(Role.Viewer);
  });

  it('throws on an unrecognized value', () => {
    expect(() => toDomainRole('SUPERUSER')).toThrow('Unrecognized Prisma role: SUPERUSER');
  });
});
