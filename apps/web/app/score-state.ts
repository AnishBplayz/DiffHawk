import type { Scorecard } from '@diffhawk/core';

/**
 * Shared shape for the scoring form's action state.
 *
 * Deliberately NOT in `actions.ts`: a `'use server'` module may only export
 * async functions, so exporting this constant from there crashes the render.
 */
export interface ScoreState {
  scorecard: Scorecard | null;
  /** Other AI reviewers found on the repo, for the "score that one instead" hint. */
  otherReviewers: string[];
  error: string | null;
  repo: string | null;
}

export const EMPTY_STATE: ScoreState = {
  scorecard: null,
  otherReviewers: [],
  error: null,
  repo: null,
};
