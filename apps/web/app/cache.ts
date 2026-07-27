import type { Scorecard } from '@diffhawk/core';

/**
 * Result cache for the public demo.
 *
 * Measured: one scoring costs ~64 GraphQL points against a 5,000/hour budget, so
 * roughly 78 scorings per hour before the demo starts erroring for everyone. A
 * launch spike would exhaust that in minutes, and the failure mode is the worst
 * kind: visitors conclude the tool is broken rather than busy.
 *
 * Caching fixes the common case rather than the worst case. Traffic to a demo
 * concentrates on a handful of repositories (the suggestions in the UI, whatever
 * is trending), so repeat lookups dominate and cost nothing.
 *
 * Deliberately in-process: it is a demo mitigation, not infrastructure. On a
 * multi-instance deploy each instance keeps its own copy, which reduces the hit
 * rate without breaking anything. Redis would be the answer if this were the
 * product rather than the shop window.
 */

interface Entry {
  scorecard: Scorecard;
  otherReviewers: string[];
  at: number;
}

const TTL_MS = 15 * 60 * 1000;
const MAX_ENTRIES = 200;

const store = new Map<string, Entry>();

const key = (owner: string, name: string) => `${owner.toLowerCase()}/${name.toLowerCase()}`;

export function readCache(owner: string, name: string): Entry | null {
  const k = key(owner, name);
  const hit = store.get(k);
  if (!hit) return null;
  if (Date.now() - hit.at > TTL_MS) {
    store.delete(k);
    return null;
  }
  // Refresh recency so the eviction below is roughly least-recently-used.
  store.delete(k);
  store.set(k, hit);
  return hit;
}

export function writeCache(
  owner: string,
  name: string,
  value: { scorecard: Scorecard; otherReviewers: string[] },
): void {
  if (store.size >= MAX_ENTRIES) {
    // Map preserves insertion order, so the first key is the least recent.
    const oldest = store.keys().next().value;
    if (oldest) store.delete(oldest);
  }
  store.set(key(owner, name), { ...value, at: Date.now() });
}

/** Age of a cached result in minutes, for honest labelling in the UI. */
export function ageMinutes(at: number): number {
  return Math.max(0, Math.round((Date.now() - at) / 60000));
}
