'use client';

import { useActionState } from 'react';
import { scoreRepoAction } from '../actions';
import { EMPTY_STATE } from '../score-state';
import { Scorecard } from './Scorecard';

const SUGGESTIONS = ['hoprnet/hoprnet', 'NethermindEth/juno', 'kubeedge/kubeedge'];

export function ScoreForm() {
  const [state, action, pending] = useActionState(scoreRepoAction, EMPTY_STATE);

  return (
    // The input stays narrow; the result must not. Constraining the scorecard to
    // the hero column squeezed its bars down to a 40px stub.
    <div id="score">
      <form action={action} className="flex max-w-[34rem] flex-col gap-2.5 sm:flex-row">
        <label className="sr-only" htmlFor="repo">
          GitHub repository
        </label>
        <input
          id="repo"
          name="repo"
          required
          defaultValue={state.repo ?? ''}
          placeholder="owner/repo"
          autoComplete="off"
          spellCheck={false}
          className="nums min-w-0 flex-1 rounded-lg border border-hairline-strong bg-surface-raised px-4 py-3 text-[15px] text-ink placeholder:text-ink-muted focus:border-accent focus:ring-2 focus:ring-accent/30 focus:outline-none"
        />
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-accent px-6 py-3 text-[15px] font-medium whitespace-nowrap text-white transition-transform active:translate-y-px disabled:opacity-60"
        >
          {pending ? 'Reading pull requests' : 'Score it'}
        </button>
      </form>

      <p className="mt-2.5 text-[12px] text-ink-muted">
        Public repositories, read-only.{' '}
        {SUGGESTIONS.map((s, i) => (
          <span key={s}>
            {i > 0 && <span className="text-hairline-strong"> / </span>}
            <button
              type="button"
              onClick={() => {
                const el = document.getElementById('repo') as HTMLInputElement | null;
                if (el) el.value = s;
              }}
              className="nums underline decoration-hairline-strong underline-offset-2 transition-colors hover:text-ink-secondary"
            >
              {s}
            </button>
          </span>
        ))}
      </p>

      {/* Loading state mirrors the shape of the result rather than spinning. */}
      {pending && (
        <div
          className="mt-7 animate-pulse rounded-xl border border-hairline bg-surface-raised p-7"
          aria-live="polite"
        >
          <div className="h-3 w-52 rounded bg-hairline" />
          <div className="mt-6 h-12 w-40 rounded bg-hairline" />
          <div className="mt-5 h-1.5 w-full rounded bg-hairline" />
          <div className="mt-7 space-y-2.5">
            <div className="h-2 w-full rounded bg-hairline" />
            <div className="h-2 w-5/6 rounded bg-hairline" />
            <div className="h-2 w-2/3 rounded bg-hairline" />
          </div>
        </div>
      )}

      {!pending && state.error && (
        <p
          className="mt-7 max-w-[60ch] rounded-lg border border-hairline bg-surface-raised px-4 py-3 text-[13px] leading-relaxed text-ink-secondary"
          role="status"
        >
          {state.error}
        </p>
      )}

      {!pending && state.scorecard && (
        <div className="mt-7">
          <Scorecard data={state.scorecard} />
          {state.otherReviewers.length > 0 && (
            <p className="mt-3 text-[12px] text-ink-muted">
              Also reviewing here: {state.otherReviewers.join(', ')}. The most active one is scored.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
