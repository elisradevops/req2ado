import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module';
import { HealthModule } from './modules/health/health.module';
import { AuthModule } from './modules/auth/auth.module';
import { LlmModule } from './modules/llm/llm.module';
import { JobsModule } from './modules/pipeline/jobs.module';

@Module({
  imports: [ConfigModule, HealthModule, AuthModule, LlmModule, JobsModule],
})
export class AppModule {}
