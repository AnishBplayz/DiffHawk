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
 * reviewer. Lets the CLI say "18% here vs 37% globally" with no network call.
 *
 * A snapshot, not live, and the scorecard labels it as such. Refreshing it
 * matters: `cubic` read 56.9% at n=813 and 43.0% at n=1112, so a frozen baseline
 * would have mis-ranked repos against it. Only reviewers with >=50 observed
 * threads are listed — below that the global rate is itself too noisy to compare
 * against, and a missing baseline is reported honestly rather than guessed.
 *
 * Source: https://github.com/AnishBplayz/ai-reviewer-census
 */
export const CENSUS_BASELINE: Record<string, number> = {
  CodeRabbit: 0.369,
  Copilot: 0.553,
  Codex: 0.428,
  Greptile: 0.429,
  Gemini: 0.436,
  cubic: 0.43,
  Cursor: 0.395,
  Claude: 0.41,
  Devin: 0.422,
};

/**
 * Global per-repo action-rate distribution (all AI reviewers), over repos with
 * >=15 AI threads. Drives the verdict bands in scoring — see score.ts.
 */
export const CENSUS_DISTRIBUTION = { p10: 0.14, median: 0.43, p90: 0.7 } as const;

export const CENSUS_META = {
  repos: 1112,
  pulls: 28238,
  aiThreads: 14588,
  /** Share of repos whose reviewer is acted on <=25% of the time. */
  shareWeakRepos: 0.2,
  asOf: '2026-07-24',
  source: 'https://github.com/AnishBplayz/ai-reviewer-census',
} as const;
