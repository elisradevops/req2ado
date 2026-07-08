import { BadRequestException, Body, Controller, Post, UnauthorizedException } from '@nestjs/common';
import { AdoPatProvider } from './ado-pat.provider';
import { loginRequestSchema } from './login.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly adoPatProvider: AdoPatProvider) {}

  /**
   * DocGen pattern: the ADO org URL + PAT ARE the identity, verified live
   * against the ADO Server's own connectionData endpoint — there is no app
   * session to issue and nothing to persist. The PAT is resent per-request
   * by the caller on ADO-write-triggering calls (e.g. POST /jobs/:id/confirm)
   * — this route only proves the credential works and returns who it is.
   */
  @Post('login')
  async login(@Body() rawBody: unknown): Promise<{ displayName: string }> {
    const parseResult = loginRequestSchema.safeParse(rawBody);
    if (!parseResult.success) {
      throw new BadRequestException('Invalid request body: adoOrgUrl must be a valid URL, pat must be non-empty');
    }
    const body = parseResult.data;

    try {
      const identity = await this.adoPatProvider.validateAndIdentify(body.adoOrgUrl, body.pat);
      return { displayName: identity.displayName };
    } catch {
      throw new UnauthorizedException('Invalid ADO organization URL or Personal Access Token');
    }
  }
}
