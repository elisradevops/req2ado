import type { ExecutionContext } from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '../src/modules/auth/auth.guard';
import { IS_PUBLIC_KEY } from '../src/modules/auth/public.decorator';

function makeContext(request: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
}

describe('AuthGuard', () => {
  it('allows a @Public() route through without checking the cookie at all', async () => {
    const sessionService = { validate: jest.fn() };
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue(true) };
    const guard = new AuthGuard(sessionService as any, reflector as any);

    const result = await guard.canActivate(makeContext({ cookies: {} }));

    expect(result).toBe(true);
    expect(sessionService.validate).not.toHaveBeenCalled();
  });

  it('reads the IS_PUBLIC_KEY metadata from both handler and class', async () => {
    const sessionService = { validate: jest.fn() };
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue(false) };
    const guard = new AuthGuard(sessionService as any, reflector as any);
    sessionService.validate.mockResolvedValue({ userId: 'u1', displayName: 'Jane' });

    await guard.canActivate(makeContext({ cookies: { req2ado_session: 'tok' } }));

    expect(reflector.getAllAndOverride).toHaveBeenCalledWith(IS_PUBLIC_KEY, [expect.anything(), expect.anything()]);
  });

  it('throws Unauthorized when no session cookie is present', async () => {
    const sessionService = { validate: jest.fn() };
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue(false) };
    const guard = new AuthGuard(sessionService as any, reflector as any);

    await expect(guard.canActivate(makeContext({ cookies: {} }))).rejects.toThrow(UnauthorizedException);
    expect(sessionService.validate).not.toHaveBeenCalled();
  });

  it('throws Unauthorized when the cookie does not match a valid session', async () => {
    const sessionService = { validate: jest.fn().mockResolvedValue(null) };
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue(false) };
    const guard = new AuthGuard(sessionService as any, reflector as any);

    await expect(
      guard.canActivate(makeContext({ cookies: { req2ado_session: 'expired-or-fake' } })),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('attaches the resolved user to the request and allows the route through on a valid session', async () => {
    const sessionService = { validate: jest.fn().mockResolvedValue({ userId: 'u1', displayName: 'Jane' }) };
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue(false) };
    const guard = new AuthGuard(sessionService as any, reflector as any);
    const request: Record<string, unknown> = { cookies: { req2ado_session: 'real-token' } };

    const result = await guard.canActivate(makeContext(request));

    expect(result).toBe(true);
    expect(sessionService.validate).toHaveBeenCalledWith('real-token');
    expect(request.user).toEqual({ userId: 'u1', displayName: 'Jane' });
  });
});
