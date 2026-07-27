import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  Headers,
  Req,
  Res,
  HttpCode,
  Inject,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { ReviewStore } from '@diffhawk/db';
import type { Queue } from 'bullmq';
import { verifySignature, repoFromEvent, ACTIONABLE_EVENTS } from './webhook.ts';

export const STORE = Symbol('STORE');
export const QUEUES = Symbol('QUEUES');

interface QueueBundle {
  backfill: Queue;
  score: Queue;
  dlq: Queue;
}

@Controller()
export class AppController {
  constructor(
    @Inject(STORE) private readonly store: ReviewStore,
    @Inject(QUEUES) private readonly queues: QueueBundle,
  ) {}

  /**
   * Webhook receiver.
   *
   * Does as little as possible: verify, dedupe, persist the repo, enqueue, 202.
   * GitHub times out at 10 seconds, and a backfill takes minutes, so any real
   * work here would guarantee redeliveries and duplicate processing. This is the
   * reason the queue exists rather than being decoration.
   */
  @Post('webhooks/github')
  @HttpCode(202)
  async webhook(
    @Req() req: FastifyRequest,
    @Headers('x-hub-signature-256') signature: string | undefined,
    @Headers('x-github-event') event: string | undefined,
    @Headers('x-github-delivery') deliveryId: string | undefined,
  ) {
    const secret = process.env.GITHUB_WEBHOOK_SECRET ?? '';
    // rawBody is captured by a Fastify content-type parser (see main.ts): the
    // signature is over the bytes GitHub sent, not over a re-serialised object.
    const raw = (req as FastifyRequest & { rawBody?: Buffer }).rawBody;

    if (!secret) throw new BadRequestException('GITHUB_WEBHOOK_SECRET is not configured');
    if (!raw || !verifySignature(raw, signature, secret)) {
      throw new BadRequestException('invalid signature');
    }
    if (!deliveryId) throw new BadRequestException('missing delivery id');

    // Idempotency: GitHub retries deliveries, so a repeat is a no-op.
    const isNew = await this.store.recordDelivery(deliveryId, event ?? 'unknown');
    if (!isNew) return { status: 'duplicate', deliveryId };

    if (!event || !ACTIONABLE_EVENTS.has(event)) {
      return { status: 'ignored', event: event ?? null };
    }

    const repo = repoFromEvent(req.body);
    if (!repo) return { status: 'ignored', reason: 'no repository in payload' };

    const row = await this.store.ensureRepo(repo.owner, repo.name);
    await this.queues.score.add('score', { repoId: row.id, owner: repo.owner, name: repo.name });

    return { status: 'queued', repo: `${repo.owner}/${repo.name}`, deliveryId };
  }

  /** Trigger a history backfill. Returns immediately; progress is pollable. */
  @Post('repos/:owner/:name/backfill')
  @HttpCode(202)
  async backfill(
    @Param('owner') owner: string,
    @Param('name') name: string,
    @Query('maxPages') maxPages?: string,
  ) {
    const repo = await this.store.ensureRepo(owner, name);
    const pages = Math.min(Math.max(Number(maxPages ?? 10), 1), 100);
    const bf = await this.store.startBackfill(repo.id, pages);
    await this.queues.backfill.add('page', {
      repoId: repo.id,
      owner,
      name,
      backfillId: bf.id,
    });
    return { status: 'queued', repo: `${owner}/${name}`, backfillId: bf.id, maxPages: pages };
  }

  /** Honest progress, including a terminal failure and its reason. */
  @Get('repos/:owner/:name/backfill')
  async backfillStatus(@Param('owner') owner: string, @Param('name') name: string) {
    const repo = await this.store.findRepo(owner, name);
    if (!repo) throw new NotFoundException(`${owner}/${name} is not tracked`);
    const bf = await this.store.activeBackfill(repo.id);
    const comments = await this.store.countComments(repo.id);
    return {
      repo: `${owner}/${name}`,
      comments,
      backfill: bf
        ? {
            id: bf.id,
            status: bf.status,
            pagesDone: bf.pagesDone,
            maxPages: bf.maxPages,
            prsIngested: bf.prsIngested,
            commentsIngested: bf.commentsIngested,
            lastError: bf.lastError,
          }
        : null,
    };
  }

  @Get('repos/:owner/:name/scorecard')
  async scorecard(
    @Param('owner') owner: string,
    @Param('name') name: string,
    @Query('reviewer') reviewer?: string,
  ) {
    const repo = await this.store.findRepo(owner, name);
    if (!repo) throw new NotFoundException(`${owner}/${name} is not tracked`);

    const reviewers = await this.store.reviewersFor(repo.id);
    const target = reviewer ?? reviewers[0]?.reviewer;
    if (!target) {
      return { repo: `${owner}/${name}`, scorecard: null, reviewers, reason: 'no reviewers ingested yet' };
    }
    const card = await this.store.latestScorecard(repo.id, target);
    return { repo: `${owner}/${name}`, reviewers, scorecard: card ?? null };
  }

  /** Liveness: the process is up. Deliberately does not touch dependencies. */
  @Get('healthz')
  health() {
    return { status: 'ok' };
  }

  /**
   * Readiness: dependencies are reachable. Split from liveness so a Postgres
   * blip pulls the pod out of the load balancer instead of restarting it.
   */
  @Get('readyz')
  async ready(@Res({ passthrough: true }) res: FastifyReply) {
    const checks: Record<string, string> = {};
    try {
      await this.store.reviewersFor(-1);
      checks.postgres = 'ok';
    } catch (err) {
      checks.postgres = (err as Error).message.slice(0, 120);
    }
    try {
      await this.queues.backfill.getWaitingCount();
      checks.redis = 'ok';
    } catch (err) {
      checks.redis = (err as Error).message.slice(0, 120);
    }
    const ok = Object.values(checks).every((v) => v === 'ok');
    res.status(ok ? 200 : 503);
    return { status: ok ? 'ready' : 'degraded', checks };
  }

  /** Queue depths and dead-letter size: the numbers an operator actually wants. */
  @Get('metrics/queues')
  async queueMetrics() {
    const [backfillWaiting, backfillActive, scoreWaiting, dlq] = await Promise.all([
      this.queues.backfill.getWaitingCount(),
      this.queues.backfill.getActiveCount(),
      this.queues.score.getWaitingCount(),
      this.queues.dlq.getWaitingCount(),
    ]);
    return {
      backfill: { waiting: backfillWaiting, active: backfillActive },
      score: { waiting: scoreWaiting },
      deadLetter: dlq,
    };
  }
}
