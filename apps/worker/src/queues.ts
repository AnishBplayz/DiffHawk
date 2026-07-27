import { Queue, Worker, type JobsOptions, type ConnectionOptions } from 'bullmq';
import IORedis from 'ioredis';

export const QUEUE_BACKFILL = 'review.backfill';
export const QUEUE_SCORE = 'review.score';
export const QUEUE_DLQ = 'review.dlq';

/**
 * BullMQ requires `maxRetriesPerRequest: null` on the connection it blocks on,
 * otherwise a transient Redis hiccup kills the blocking read and the worker
 * stops consuming without failing loudly.
 */
export function redisConnection(url: string): IORedis {
  return new IORedis(url, { maxRetriesPerRequest: null, enableReadyCheck: true });
}

export function connectionFor(url: string): ConnectionOptions {
  return redisConnection(url) as unknown as ConnectionOptions;
}

/**
 * Retry policy.
 *
 * Exponential with jitter, because a fleet that retries on a fixed schedule
 * synchronises its replicas into a thundering herd against the same rate limit
 * it is already backing off from. `removeOnFail: false` keeps failures
 * inspectable rather than vanishing.
 */
export const DEFAULT_JOB_OPTS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 2_000 },
  removeOnComplete: { count: 500 },
  removeOnFail: false,
};

export interface Queues {
  backfill: Queue;
  score: Queue;
  dlq: Queue;
  close: () => Promise<void>;
}

export function makeQueues(redisUrl: string): Queues {
  const connection = connectionFor(redisUrl);
  const backfill = new Queue(QUEUE_BACKFILL, { connection, defaultJobOptions: DEFAULT_JOB_OPTS });
  const score = new Queue(QUEUE_SCORE, { connection, defaultJobOptions: DEFAULT_JOB_OPTS });
  // The dead letter queue itself must not retry; it is a terminal record.
  const dlq = new Queue(QUEUE_DLQ, { connection, defaultJobOptions: { attempts: 1, removeOnFail: false } });

  return {
    backfill,
    score,
    dlq,
    close: async () => {
      await Promise.allSettled([backfill.close(), score.close(), dlq.close()]);
    },
  };
}

/**
 * Move a permanently failed job to the DLQ with its full input retained.
 *
 * A dead letter queue you cannot replay from is a landfill, so the original
 * payload is preserved verbatim alongside the failure reason.
 */
export async function toDeadLetter(
  dlq: Queue,
  info: { queue: string; jobName: string; data: unknown; error: string; attemptsMade: number },
): Promise<void> {
  await dlq.add('dead', {
    ...info,
    failedAt: new Date().toISOString(),
  });
}

export type { Worker };
