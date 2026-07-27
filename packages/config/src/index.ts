import { z } from 'zod';

/**
 * `.diffhawk.yml` — repo-level configuration. Every field is optional; the
 * defaults are what the census showed to be sensible, so a repo with no config
 * file at all gets a correct scorecard. Parsing is strict on shape (a typo'd key
 * is an error, not a silent ignore) but forgiving on absence.
 */
export const DiffhawkConfig = z.object({
  version: z.literal(1).default(1),
  /** 'auto' scores the most active reviewer; a list restricts to those vendors. */
  reviewers: z.union([z.literal('auto'), z.array(z.string())]).default('auto'),
  /** Reporting window in days. */
  windowDays: z.number().int().positive().default(90),
  /** Recent pulls to inspect. Must cover two windows for trend detection. */
  prLimit: z.number().int().positive().default(120),
  /** Paths excluded from measurement (not "suppressed" — just not signal). */
  ignore: z.array(z.string()).default([]),
  flags: z
    .object({
      /** Trip a degradation flag when effectiveness drops this many points. */
      degradationDropPts: z.number().default(15),
      /** Flag when the repo sits well below the reviewer's census baseline. */
      bottomDecile: z.boolean().default(true),
    })
    .default({ degradationDropPts: 15, bottomDecile: true }),
  report: z
    .object({
      postScorecard: z.boolean().default(true),
    })
    .default({ postScorecard: true }),
});

export type DiffhawkConfig = z.infer<typeof DiffhawkConfig>;

export const DEFAULT_CONFIG: DiffhawkConfig = DiffhawkConfig.parse({});

export interface ParseResult {
  config: DiffhawkConfig;
  /** Non-fatal notes (e.g. "no config file, using defaults"). */
  notes: string[];
}

/**
 * Parse a `.diffhawk.yml` string. `raw` is already-parsed YAML/JSON (the caller
 * owns file reading and YAML decoding — Bun's `YAML.parse` or `Bun.file`), so
 * this package stays dependency-light and trivially testable with plain objects.
 *
 * Accepts both `snake_case` (idiomatic YAML) and the camelCase schema keys, so
 * users can write `window_days` and `degradation_drop_pts` as one would expect.
 */
export function parseConfig(raw: unknown): ParseResult {
  const notes: string[] = [];
  if (raw == null) return { config: DEFAULT_CONFIG, notes: ['no config found — using defaults'] };

  const normalized = normalizeKeys(raw);
  const parsed = DiffhawkConfig.safeParse(normalized);
  if (!parsed.success) {
    // A malformed config should not silently score with hidden defaults — the
    // user asked for something specific and got it wrong; tell them.
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new ConfigError(`Invalid .diffhawk.yml:\n  - ${issues.join('\n  - ')}`);
  }
  return { config: parsed.data, notes };
}

export class ConfigError extends Error {}

/** Recursively convert snake_case keys to camelCase so YAML reads naturally. */
function normalizeKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const camel = k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
      out[camel] = normalizeKeys(v);
    }
    return out;
  }
  return value;
}
