import { BadRequestException, Body, Controller, Post, UnauthorizedException } from '@nestjs/common';
import { AdoPatProvider } from './ado-pat.provider';
import { loginRequestSchema } from './login.dto';
import { PrismaService } from './prisma.service';
import { SessionService } from './session.service';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly adoPatProvider: AdoPatProvider,
    private readonly prisma: PrismaService,
    private readonly sessionService: SessionService,
  ) {}

  @Post('login')
  async login(@Body() rawBody: unknown): Promise<{ token: string }> {
    const parseResult = loginRequestSchema.safeParse(rawBody);
    if (!parseResult.success) {
      throw new BadRequestException('Invalid request body: adoOrgUrl must be a valid URL, pat must be non-empty');
    }
    const body = parseResult.data;

    let identity;
    try {
      identity = await this.adoPatProvider.validateAndIdentify(body.adoOrgUrl, body.pat);
    } catch {
      throw new UnauthorizedException('Invalid ADO organization URL or Personal Access Token');
    }

    const user = await this.prisma.user.upsert({
      where: { email: identity.identity },
      update: {},
      create: { email: identity.identity },
    });

    const token = this.sessionService.issue({ userId: user.id });
    return { token };
  }
}
