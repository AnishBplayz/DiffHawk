import type Redis from 'ioredis';

/**
 * Token bucket shared across every worker replica, held in Redis.
 *
 * The point is that scaling workers up must not scale you into a ban. A limiter
 * held in process memory would let N replicas each believe they own the full
 * GitHub budget, so the effective request rate would be N times the intended
 * one. Keeping the bucket in Redis makes the budget a property of the fleet.
 *
 * Implemented as a Lua script so the read-refill-decrement sequence is atomic:
 * done as three round trips, two workers can both observe one token remaining
 * and both take it.
 */
const ACQUIRE = `
local key      = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill   = tonumber(ARGV[2])   -- tokens per second
local now      = tonumber(ARGV[3])   -- milliseconds
local cost     = tonumber(ARGV[4])

local bucket = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(bucket[1])
local ts     = tonumber(bucket[2])

if tokens == nil then
  tokens = capacity
  ts = now
end

-- Refill for elapsed time, capped at capacity.
local elapsed = math.max(0, now - ts) / 1000.0
tokens = math.min(capacity, tokens + elapsed * refill)

if tokens >= cost then
  tokens = tokens - cost
  redis.call('HMSET', key, 'tokens', tokens, 'ts', now)
  redis.call('PEXPIRE', key, 60000)
  return -1                          -- granted
end

-- Denied: report how long to wait for the shortfall, in milliseconds.
local deficit = cost - tokens
redis.call('HMSET', key, 'tokens', tokens, 'ts', now)
redis.call('PEXPIRE', key, 60000)
return math.ceil((deficit / refill) * 1000)
`;

export interface LimiterOptions {
  key?: string;
  /** Burst size. */
  capacity?: number;
  /** Sustained rate, tokens per second. */
  refillPerSecond?: number;
}

export class SharedRateLimiter {
  #redis: Redis;
  #key: string;
  #capacity: number;
  #refill: number;

  constructor(redis: Redis, opts: LimiterOptions = {}) {
    this.#redis = redis;
    this.#key = opts.key ?? 'diffhawk:ratelimit:github';
    // GitHub allows 5000 REST points/hour for a user token, and GraphQL is
    // budgeted separately. ~1.2/s sustained with a burst of 20 stays well clear
    // while keeping a backfill moving.
    this.#capacity = opts.capacity ?? 20;
    this.#refill = opts.refillPerSecond ?? 1.2;
  }

  /** Wait until a token is available, then consume it. */
  async acquire(cost = 1): Promise<void> {
    for (;;) {
      const waitMs = (await this.#redis.eval(
        ACQUIRE,
        1,
        this.#key,
        String(this.#capacity),
        String(this.#refill),
        String(Date.now()),
        String(cost),
      )) as number;

      if (waitMs === -1) return;
      // Small jitter so replicas released by the same refill do not all retry
      // on the identical millisecond and thunder against the bucket.
      await new Promise((r) => setTimeout(r, waitMs + Math.floor(Math.random() * 50)));
    }
  }
}
