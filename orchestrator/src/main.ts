import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.use(helmet());
  // Only enabled when CORS_ORIGIN is set (local dev with the frontend on
  // its own Vite origin/port) — unset in the intended production topology
  // (frontend same-origin behind nginx), so this never opens CORS by default.
  if (process.env.CORS_ORIGIN) {
    app.enableCors({ origin: process.env.CORS_ORIGIN, credentials: true });
  }
  const port = process.env.PORT ?? 3001;
  await app.listen(port);
}

void bootstrap();
