import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LlmController } from './llm.controller';
import { LlmStatusController } from './llm-status.controller';
import { LlmConnectionController } from './llm-connection.controller';
import { LlmProxyBearerGuard } from './llm-proxy-bearer.guard';
import { OpenWebUiClientFactory, type OpenWebUiGlobalConfig } from './openwebui-client.factory';
import { LlmConfigResolver } from '../auth/llm-config.resolver';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [ConfigModule, AuthModule],
  controllers: [LlmController, LlmStatusController, LlmConnectionController],
  providers: [
    LlmProxyBearerGuard,
    {
      // OpenWebUiClientFactory takes a plain global-config object, not a
      // ConfigService -- see its own doc comment for why (pipeline.
      // processor.ts, which has no DI container, needs to construct it the
      // same way). This useFactory is where that object gets built from
      // this module's real ConfigService, same explicit-factory pattern
      // this codebase already uses for every other config-carrying
      // provider (see e.g. JobsModule's EtaService/BackfillService wiring).
      provide: OpenWebUiClientFactory,
      inject: [ConfigService, LlmConfigResolver],
      useFactory: (config: ConfigService, llmConfigResolver: LlmConfigResolver) => {
        const globalConfig: OpenWebUiGlobalConfig = {
          LLM_BASE_URL: config.get<string>('LLM_BASE_URL')!,
          LLM_TRUSTED_LOCAL: config.get<boolean>('LLM_TRUSTED_LOCAL')!,
          EMBED_TRANSPORT: config.get<'ollama' | 'openai'>('EMBED_TRANSPORT')!,
          EMBED_BASE_URL: config.get<string>('EMBED_BASE_URL'),
          EMBED_MODEL: config.get<string>('EMBED_MODEL')!,
          EMBED_PATH: config.get<string>('EMBED_PATH')!,
          SHOW_PATH: config.get<string>('SHOW_PATH')!,
          FILES_UPLOAD_PATH: config.get<string>('FILES_UPLOAD_PATH')!,
          FILES_STATUS_PATH: config.get<string>('FILES_STATUS_PATH')!,
          LLM_REQUEST_TIMEOUT_MS: config.get<number>('LLM_REQUEST_TIMEOUT_MS')!,
        };
        return new OpenWebUiClientFactory(globalConfig, llmConfigResolver);
      },
    },
  ],
  // LlmProxyBearerGuard exported too -- JobsModule reuses this same
  // ingestion-service-to-service bearer guard for its new figure-file
  // upload endpoint (see JobsController) rather than inventing a second
  // bearer-token convention for the same "caller is ingestion" need.
  // OpenWebUiClientFactory exported so other modules (ChatModule,
  // JobsModule, DocumentOverviewService's consumers) can resolve a
  // per-user client without a circular import back through this module's
  // own controllers.
  exports: [OpenWebUiClientFactory, LlmProxyBearerGuard],
})
export class LlmModule {}
