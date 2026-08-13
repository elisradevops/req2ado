import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LlmController } from './llm.controller';
import { LlmStatusController } from './llm-status.controller';
import { LlmProxyBearerGuard } from './llm-proxy-bearer.guard';
import { OpenWebUiClient } from './openwebui.client';

@Module({
  imports: [ConfigModule],
  controllers: [LlmController, LlmStatusController],
  providers: [
    LlmProxyBearerGuard,
    {
      provide: OpenWebUiClient,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new OpenWebUiClient({
          LLM_BASE_URL: config.get<string>('LLM_BASE_URL')!,
          LLM_API_KEY: config.get<string>('LLM_API_KEY'),
          LLM_CHAT_MODEL: config.get<string>('LLM_CHAT_MODEL')!,
          LLM_VISION_MODEL: config.get<string>('LLM_VISION_MODEL'),
          LLM_TRUSTED_LOCAL: config.get<boolean>('LLM_TRUSTED_LOCAL')!,
          EMBED_TRANSPORT: config.get<'ollama' | 'openai'>('EMBED_TRANSPORT')!,
          EMBED_BASE_URL: config.get<string>('EMBED_BASE_URL'),
          EMBED_MODEL: config.get<string>('EMBED_MODEL')!,
          EMBED_PATH: config.get<string>('EMBED_PATH')!,
          SHOW_PATH: config.get<string>('SHOW_PATH')!,
          FILES_UPLOAD_PATH: config.get<string>('FILES_UPLOAD_PATH')!,
          FILES_STATUS_PATH: config.get<string>('FILES_STATUS_PATH')!,
          LLM_REQUEST_TIMEOUT_MS: config.get<number>('LLM_REQUEST_TIMEOUT_MS')!,
        }),
    },
  ],
  // LlmProxyBearerGuard exported too -- JobsModule reuses this same
  // ingestion-service-to-service bearer guard for its new figure-file
  // upload endpoint (see JobsController) rather than inventing a second
  // bearer-token convention for the same "caller is ingestion" need.
  exports: [OpenWebUiClient, LlmProxyBearerGuard],
})
export class LlmModule {}
