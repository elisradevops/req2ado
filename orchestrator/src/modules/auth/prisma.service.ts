import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/** Thin PrismaClient wrapper with NestJS lifecycle hooks. Scoped to the auth
 * module for now since it's the only Prisma consumer in the app so far — if
 * a later phase needs Prisma elsewhere, extract this into a shared
 * PrismaModule at that point rather than duplicating this wrapper. */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
