import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import { RolesGuard } from '../src/modules/auth/roles.guard';
import { Role } from '../src/modules/auth/roles.enum';
import { ROLES_KEY } from '../src/modules/auth/roles.decorator';

function makeContext(role: Role | undefined, requiredRoles: Role[] | undefined): ExecutionContext {
  const reflectorSpy = jest.spyOn(Reflector.prototype, 'getAllAndOverride').mockReturnValue(requiredRoles);
  const context = {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => ({ user: role ? { role } : undefined }) }),
  } as unknown as ExecutionContext;
  return Object.assign(context, { __reflectorSpy: reflectorSpy });
}

describe('RolesGuard', () => {
  afterEach(() => jest.restoreAllMocks());

  it('allows access when no roles are required', () => {
    const guard = new RolesGuard(new Reflector());
    const context = makeContext(undefined, undefined);
    expect(guard.canActivate(context)).toBe(true);
  });

  it('allows access when user role matches a required role', () => {
    const guard = new RolesGuard(new Reflector());
    const context = makeContext(Role.Operator, [Role.Operator, Role.Admin]);
    expect(guard.canActivate(context)).toBe(true);
  });

  it('denies access when user role does not match', () => {
    const guard = new RolesGuard(new Reflector());
    const context = makeContext(Role.Viewer, [Role.Operator, Role.Admin]);
    expect(() => guard.canActivate(context)).toThrow('Requires one of roles: operator, admin');
  });

  it('denies access when no user is present', () => {
    const guard = new RolesGuard(new Reflector());
    const context = makeContext(undefined, [Role.Admin]);
    expect(() => guard.canActivate(context)).toThrow('Requires one of roles: admin');
  });
});
