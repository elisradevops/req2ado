import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LlmController } from './llm.controller';
import { LlmProxyBearerGuard } from './llm-proxy-bearer.guard';
import { OpenWebUiClient } from './openwebui.client';

@Module({
  imports: [ConfigModule],
  controllers: [LlmController],
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
          LLM_TRUSTED_LOCAL: config.get<boolean>('LLM_TRUSTED_LOCAL')!,
        }),
    },
  ],
  exports: [OpenWebUiClient],
})
export class LlmModule {}
