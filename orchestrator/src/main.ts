import './tracing';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { WsAdapter } from '@nestjs/platform-ws';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/http-exception.filter';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // Express's default json() body limit is 100kb -- POST /llm/vision sends a
  // base64-encoded embedded image (observed live: up to ~900kb base64 for a
  // real customer docx's largest diagram), which silently failed every such
  // call with 413 Payload Too Large, swallowed by ingestion's per-figure
  // try/except with (until now) no logging -- looked exactly like a vision
  // model/capability problem but was this limit. 10mb covers realistic
  // embedded-image sizes with headroom; this route is bearer-guarded
  // service-to-service traffic, not public-facing.
  app.useBodyParser('json', { limit: '10mb' });
  // Previously no SIGTERM/SIGINT handling at all -- a k8s pod termination
  // (rolling update, scale-down, node drain) killed the process immediately,
  // mid in-flight request, with no chance to finish or clean up. Nest's
  // built-in shutdown hooks stop accepting new connections and run every
  // module's onModuleDestroy/beforeApplicationShutdown lifecycle hook on
  // SIGTERM/SIGINT before the process actually exits.
  app.enableShutdownHooks();
  app.useGlobalFilters(new HttpExceptionFilter());
  app.use(helmet());
  // Session cookie (AuthGuard, auth.controller.ts) is read via
  // req.cookies -- must run before any guard/route handler.
  app.use(cookieParser());
  // ChatGateway (modules/chat) needs a raw `ws` WebSocket adapter -- Nest's
  // default platform (socket.io) is a different wire protocol the frontend's
  // chat client doesn't speak.
  app.useWebSocketAdapter(new WsAdapter(app));
  // Only enabled when CORS_ORIGIN is set (local dev with the frontend on
  // its own Vite origin/port) — unset in the intended production topology
  // (frontend same-origin behind nginx), so this never opens CORS by default.
  if (process.env.CORS_ORIGIN) {
    app.enableCors({ origin: process.env.CORS_ORIGIN, credentials: true });
  }
  const port = process.env.PORT ?? 3001;
  await app.listen(port);

  // Backstop: if some future provider ever adds its own un-closed handle
  // (a raw socket/timer not wired into a lifecycle hook), don't let a k8s
  // termination hang indefinitely waiting for a graceful exit that never
  // comes -- force-exit 10s after the signal regardless. .unref() so this
  // timer itself never keeps the process alive during a NORMAL graceful
  // exit (once every real handle actually closes).
  const forceExitAfterShutdown = (): void => {
    const timer = setTimeout(() => process.exit(1), 10_000);
    timer.unref();
  };
  process.on('SIGTERM', forceExitAfterShutdown);
  process.on('SIGINT', forceExitAfterShutdown);
}

void bootstrap();
