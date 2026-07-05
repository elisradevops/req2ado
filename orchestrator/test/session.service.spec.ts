import { JwtService } from '@nestjs/jwt';
import { SessionService } from '../src/modules/auth/session.service';

describe('SessionService', () => {
  it('issues a token that verifies back to the same payload', () => {
    const service = new SessionService(new JwtService({ secret: 'test-secret' }));

    const token = service.issue({ userId: 'user-1' });
    const decoded = service.verify(token);

    expect(decoded.userId).toBe('user-1');
  });

  it('throws when verifying a token signed with a different secret', () => {
    const issuer = new SessionService(new JwtService({ secret: 'secret-a' }));
    const verifier = new SessionService(new JwtService({ secret: 'secret-b' }));

    const token = issuer.issue({ userId: 'user-1' });

    expect(() => verifier.verify(token)).toThrow();
  });
});
