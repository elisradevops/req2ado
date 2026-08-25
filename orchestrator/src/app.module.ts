import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ConfigModule } from './config/config.module';
import { HealthModule } from './modules/health/health.module';
import { AuthModule } from './modules/auth/auth.module';
import { AuthGuard } from './modules/auth/auth.guard';
import { LlmModule } from './modules/llm/llm.module';
import { JobsModule } from './modules/pipeline/jobs.module';
import { ChatModule } from './modules/chat/chat.module';
import { KbModule } from './modules/kb/kb.module';
import { WikiModule } from './modules/wiki/wiki.module';
import { SettingsModule } from './modules/settings/settings.module';

@Module({
  imports: [
    ConfigModule,
    // 200 requests per 60-second window per client — generous enough that no
    // existing or new test in this project's suites (which never issue more
    // than ~20 requests in a single test) trips this, while still providing
    // real abuse protection in production.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 200 }]),
    HealthModule,
    AuthModule,
    LlmModule,
    JobsModule,
    ChatModule,
    KbModule,
    WikiModule,
    SettingsModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    // Runs after ThrottlerGuard (declared second -- Nest evaluates
    // multiple APP_GUARD entries in registration order). Global by
    // default; @Public() (health, auth/login, auth/me, auth/logout,
    // LlmController's bearer-guarded service-to-service routes) is the
    // explicit opt-out, so any new controller is protected unless it says
    // otherwise.
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule {}
