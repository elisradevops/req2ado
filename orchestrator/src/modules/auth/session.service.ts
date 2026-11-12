import { Injectable } from '@nestjs/common';
// Real (non-type) import: Nest's constructor injection reads the reflected
// param type at runtime -- `import type` erases the class reference and
// Nest can't match it to the PrismaClient provider token (see
// HealthController's own comment on this exact issue).
import { PrismaClient } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';
import { SESSION_TTL_MS } from './session.constants';

export interface SessionUser {
  userId: string;
  displayName: string;
  // What ADO also said about the person at sign-in; absent for a session issued before these were kept.
  email?: string;
  accountName?: string;
  adoUserGuid?: string;
}

export interface SessionProfile {
  email?: string;
  accountName?: string;
  adoUserGuid?: string;
}

// Only sha256(token) is ever persisted -- a DB read (or dump/backup leak)
// alone must never be enough to impersonate a session, same reasoning as
// never storing a PAT in plaintext.
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

@Injectable()
export class SessionService {
  constructor(private readonly prisma: PrismaClient) {}

  /** Issues a new session for a just-validated ADO identity, returns the raw token to set in the cookie. */
  async create(userId: string, displayName: string, profile: SessionProfile = {}): Promise<string> {
    const token = randomBytes(32).toString('hex');
    await this.prisma.session.create({
      data: {
        tokenHash: hashToken(token),
        userId,
        displayName,
        ...(profile.email ? { email: profile.email } : {}),
        ...(profile.accountName ? { accountName: profile.accountName } : {}),
        ...(profile.adoUserGuid ? { adoUserGuid: profile.adoUserGuid } : {}),
        expiresAt: new Date(Date.now() + SESSION_TTL_MS),
      },
    });
    return token;
  }

  /** Looks up the session for a raw cookie token. Null on unknown or expired -- caller can't distinguish which (no signal to leak). */
  async validate(token: string): Promise<SessionUser | null> {
    const session = await this.prisma.session.findUnique({ where: { tokenHash: hashToken(token) } });
    if (!session || session.expiresAt.getTime() < Date.now()) return null;
    return {
      userId: session.userId,
      displayName: session.displayName,
      ...(session.email ? { email: session.email } : {}),
      ...(session.accountName ? { accountName: session.accountName } : {}),
      ...(session.adoUserGuid ? { adoUserGuid: session.adoUserGuid } : {}),
    };
  }

  /** Revokes a session by its raw token (logout) -- a real DELETE, not a TTL wait; this is the whole reason sessions aren't a JWT. */
  async revoke(token: string): Promise<void> {
    await this.prisma.session.deleteMany({ where: { tokenHash: hashToken(token) } });
  }
}
