import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Role } from './roles.enum';

export interface SessionPayload {
  userId: string;
  role: Role;
}

/** Issues/verifies short-lived app session tokens. NEVER embeds the ADO PAT
 * — only { userId, role }. The PAT continues to be sent per-request as a
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
