import { test, expect } from 'bun:test';
import { parseConfig, ConfigError, DEFAULT_CONFIG } from './index.ts';

test('empty / missing config yields sane defaults', () => {
  expect(parseConfig(null).config).toEqual(DEFAULT_CONFIG);
  expect(parseConfig({}).config.windowDays).toBe(90);
  expect(parseConfig({}).config.reviewers).toBe('auto');
});

test('accepts snake_case keys from YAML', () => {
  const { config } = parseConfig({
    window_days: 30,
    pr_limit: 200,
    flags: { degradation_drop_pts: 20, bottom_decile: false },
    report: { post_scorecard: false },
  });
  expect(config.windowDays).toBe(30);
  expect(config.prLimit).toBe(200);
  expect(config.flags.degradationDropPts).toBe(20);
  expect(config.flags.bottomDecile).toBe(false);
  expect(config.report.postScorecard).toBe(false);
});

test('reviewers can be a pinned list', () => {
  expect(parseConfig({ reviewers: ['CodeRabbit', 'Copilot'] }).config.reviewers).toEqual([
    'CodeRabbit',
    'Copilot',
  ]);
});

test('an invalid value fails loudly rather than silently defaulting', () => {
  expect(() => parseConfig({ window_days: -5 })).toThrow(ConfigError);
  expect(() => parseConfig({ window_days: 'lots' })).toThrow(ConfigError);
});
