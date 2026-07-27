#!/usr/bin/env bun
import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { connect, migrate, ReviewStore } from '@diffhawk/db';
import { AppController, STORE, QUEUES } from './app.controller.ts';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5433/diffhawk';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6380';
const PORT = Number(process.env.PORT ?? 3200);

const { db, close: closeDb } = connect(DATABASE_URL);
const store = new ReviewStore(db);

const redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
const queues = {
  backfill: new Queue('review.backfill', { connection: redis }),
  score: new Queue('review.score', { connection: redis }),
  dlq: new Queue('review.dlq', { connection: redis }),
};

@Module({
  controllers: [AppController],
  providers: [
    { provide: STORE, useValue: store },
    { provide: QUEUES, useValue: queues },
  ],
})
class AppModule {}

async function bootstrap(): Promise<void> {
  await migrate(db);

  const adapter = new FastifyAdapter({ logger: false });

  /**
   * Capture the raw body for webhook signature verification.
   *
   * The HMAC must be computed over the exact bytes GitHub sent; verifying a
   * re-serialised object silently never matches, and the usual workaround is to
   * turn verification off. So the raw buffer is kept alongside the parsed body.
   */
  adapter.getInstance().addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (req, body, done) => {
      (req as unknown as { rawBody: Buffer }).rawBody = body as Buffer;
      try {
        done(null, JSON.parse((body as Buffer).toString('utf8')));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  // bodyParser: false because the raw-body parser above IS the JSON parser.
  // Letting Nest register its own would collide with it, and Fastify rejects a
  // duplicate content-type parser outright.
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    logger: ['error', 'warn', 'log'],
    bodyParser: false,
  });

  // Give in-flight requests a chance to finish on SIGTERM rather than cutting
  // them off mid-response during a rolling deploy.
  app.enableShutdownHooks();

  await app.listen({ port: PORT, host: '0.0.0.0' });
  process.stdout.write(
    JSON.stringify({ level: 'info', msg: 'api listening', port: PORT, at: new Date().toISOString() }) + '\n',
  );

  const shutdown = async (signal: string) => {
    process.stdout.write(JSON.stringify({ level: 'info', msg: 'api shutting down', signal }) + '\n');
    await app.close();
    await Promise.allSettled([queues.backfill.close(), queues.score.close(), queues.dlq.close()]);
    await redis.quit().catch(() => {});
    await closeDb();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

bootstrap().catch((err) => {
  process.stderr.write(
    JSON.stringify({ level: 'error', msg: 'api failed to start', error: (err as Error).stack }) + '\n',
  );
  process.exit(1);
});
