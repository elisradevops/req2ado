import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import { LlmModule } from '../llm/llm.module';
import { AuthModule } from '../auth/auth.module';
import { ChatController } from './chat.controller';
import { ChatGateway } from './chat.gateway';
import { ChatService } from './chat.service';

@Module({
  imports: [ConfigModule, LlmModule, AuthModule],
  controllers: [ChatController],
  providers: [
    { provide: PrismaClient, useValue: new PrismaClient() },
    {
      provide: 'CHAT_REDIS_CLIENT',
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const redis = new Redis(config.get<string>('REDIS_URL')!);
        // eslint-disable-next-line no-console -- no structured logger in this module yet
        redis.on('error', (err) => console.error('Chat Redis client error:', err));
        return redis;
      },
    },
    {
      provide: 'CHAT_REDIS_SUBSCRIBER',
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const redis = new Redis(config.get<string>('REDIS_URL')!);
        // eslint-disable-next-line no-console -- no structured logger in this module yet
        redis.on('error', (err) => console.error('Chat Redis subscriber error:', err));
        return redis;
      },
    },
    {
      provide: ChatService,
      inject: [PrismaClient, ConfigService, 'CHAT_REDIS_CLIENT'],
      useFactory: (prisma: PrismaClient, config: ConfigService, redis: Redis) =>
        new ChatService(prisma, config.get<string>('INGESTION_BASE_URL')!, redis),
    },
    // Registered as a plain class provider (not useFactory) — NestJS's
    // WebSocket gateway auto-discovery (SocketModule.connectGatewayToServer)
    // reads wrapper.metatype to find the @WebSocketGateway() metadata, and
    // metatype is only set to the real class for class-based providers. A
    // useFactory provider's metatype is null, so the gateway instance would
    // be constructed but silently never wired to the WS server (confirmed
    // live: the WS handshake 404'd — Node fell through to the normal HTTP
    // request path since no 'upgrade' listener was ever attached). Redis
    // injection uses @Inject('CHAT_REDIS_SUBSCRIBER') on the constructor
    // param instead (see chat.gateway.ts).
    ChatGateway,
  ],
})
export class ChatModule {}
