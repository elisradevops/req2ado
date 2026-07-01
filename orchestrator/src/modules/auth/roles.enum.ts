export enum Role {
  Admin = 'admin',
  Operator = 'operator',
  Viewer = 'viewer',
}

/**
 * Converts Prisma's uppercase `Role` enum values (`ADMIN|OPERATOR|VIEWER`,
 * see prisma/schema.prisma) to this module's lowercase TS `Role` enum, which
 * `RolesGuard` compares against. No caller hydrates a user from Postgres yet
 * (the stub `AzureAdProvider` returns a TS `Role` directly), so this seam is
 * unused today — it exists now, tested, so that once a real user role loads
 * from the DB it doesn't silently fail every `RolesGuard` check.
 */
export function toDomainRole(prismaRole: string): Role {
  switch (prismaRole) {
    case 'ADMIN':
      return Role.Admin;
    case 'OPERATOR':
      return Role.Operator;
    case 'VIEWER':
      return Role.Viewer;
    default:
      throw new Error(`Unrecognized Prisma role: ${prismaRole}`);
  }
}
