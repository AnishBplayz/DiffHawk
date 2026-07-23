/**
 * @diffhawk/ingest — reviewer identity.
 *
 * The bot registry is promoted verbatim from the AI Code Review Census, where it
 * was tested against known-positive repositories across 800+ scans. It already
 * handles the trap that cost the census a day: GitHub reports bot logins as
 * `example[bot]` via REST/search but `example` via GraphQL, so all lookups
 * normalise before comparing.
 */
export {
  BOTS,
  identifyBot,
  isAiReviewer,
  isUnclassifiedBot,
  normalizeLogin,
  type BotIdentity,
  type BotCategory,
} from './bots.ts';

/**
 * Census baseline — global effectiveness (share of comments acted on) per
 * reviewer, from the census at n=813. Lets the CLI say "18% here vs 37% globally"
 * with no network call. A snapshot, not live: refreshed from the census, and the
 * scorecard labels it as such.
 *
 * Source: https://github.com/AnishBplayz/ai-reviewer-census
 */
export const CENSUS_BASELINE: Record<string, number> = {
  CodeRabbit: 0.365,
  Copilot: 0.56,
  Codex: 0.409,
  Greptile: 0.439,
  Gemini: 0.401,
  Cursor: 0.404,
  Claude: 0.41,
  cubic: 0.569,
};

/** Global per-repo action-rate distribution (all AI reviewers), census n=813. */
export const CENSUS_DISTRIBUTION = { p10: 0.13, median: 0.44, p90: 0.69 } as const;

export const CENSUS_META = {
  repos: 813,
  pulls: 22514,
  source: 'https://github.com/AnishBplayz/ai-reviewer-census',
} as const;
