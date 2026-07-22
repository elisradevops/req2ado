import { Controller, Get, HttpException, HttpStatus, type OnModuleDestroy } from '@nestjs/common';
// Real (non-`import type`) imports: Nest's automatic constructor injection
// for a plain @Controller() (unlike JobsService, which sidesteps this via
// an explicit useFactory -- see jobs.module.ts's own comment on the same
// issue for IdempotencyService) relies on reflected constructor-parameter
// types at runtime. `import type` erases the class reference entirely, so
// Nest sees the param type as `Object` and can't match it to either
// provider token below -- found live: "Nest can't resolve dependencies of
// the HealthController (?, Function)".
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';

@Controller()
export class HealthController implements OnModuleDestroy {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly redis: Redis,
  ) {}

  // Same leak class as JobsService.queue: an un-closed raw ioredis socket
  // keeps the Node event loop alive indefinitely, so app.close() on SIGTERM
  // never actually let the process exit.
  async onModuleDestroy(): Promise<void> {
    this.redis.disconnect();
  }

  /**
   * Liveness: process is up, nothing more. Deliberately does NOT check
   * Postgres/Redis reachability -- a k8s liveness-probe failure restarts
   * the pod, which is the wrong response to "a dependency blipped" (that's
   * what /ready is for). Previously the ONLY health endpoint, unconditional
   * {ok:true} regardless of dependency state.
   */
  @Get('health')
  liveness(): { ok: true } {
    return { ok: true };
  }

  /**
   * Readiness: real Postgres + Redis reachability checks. A k8s readiness
   * probe failure removes the pod from load-balancing without restarting
   * it -- correct for "a dependency is temporarily down."
   */
  @Get('ready')
  async readiness(): Promise<{ ok: true; postgres: true; redis: true }> {
    const [postgresOk, redisOk] = await Promise.all([this.checkPostgres(), this.checkRedis()]);
    if (!postgresOk || !redisOk) {
      throw new HttpException(
        { ok: false, postgres: postgresOk, redis: redisOk },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return { ok: true, postgres: true, redis: true };
  }

  private async checkPostgres(): Promise<boolean> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }

  private async checkRedis(): Promise<boolean> {
    try {
      return (await this.redis.ping()) === 'PONG';
    } catch {
      return false;
    }
  }
}
