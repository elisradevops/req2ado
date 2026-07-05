import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

export interface SessionPayload {
  userId: string;
}

/** Issues/verifies short-lived app session tokens. NEVER embeds the ADO PAT
 * — only { userId }. The PAT continues to be sent per-request as a
 * header for ADO-bound calls, unchanged from Phase 0. */
@Injectable()
export class SessionService {
  constructor(private readonly jwtService: JwtService) {}

  issue(payload: SessionPayload): string {
    return this.jwtService.sign(payload);
  }

  verify(token: string): SessionPayload {
    return this.jwtService.verify<SessionPayload>(token);
  }
}
