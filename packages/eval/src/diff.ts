/**
 * Parse a unified-diff patch into the set of new-file line ranges it touches.
 *
 * This is the atom of the independent ground truth: given the patch of a commit
 * pushed *after* a review comment, which lines in the new version of the file
 * did it change? If any overlap the commented line, the comment was plausibly
 * acted on — a signal computed from real commits, entirely separate from
 * GitHub's `isOutdated` flag, which is what makes it a fair yardstick for it.
 */

export type LineRange = [start: number, end: number];

/**
 * Extract changed line ranges (in the NEW file) from a GitHub patch string.
 *
 * Hunk headers look like `@@ -oldStart,oldLen +newStart,newLen @@`. We walk the
 * hunk body and record the new-file line numbers of added and context-adjacent
 * changes. Pure deletions (no added line) still matter — the code at that point
 * changed — so a hunk with only deletions is recorded at its new-file position.
 */
export function changedRanges(patch: string | undefined | null): LineRange[] {
  if (!patch) return [];
  const ranges: LineRange[] = [];
  const lines = patch.split('\n');

  let newLine = 0;
  let runStart = -1;
  let runEnd = -1;

  const closeRun = () => {
    if (runStart !== -1) {
      ranges.push([runStart, runEnd]);
      runStart = -1;
      runEnd = -1;
    }
  };

  for (const line of lines) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (header) {
      closeRun();
      newLine = Number(header[1]);
      continue;
    }
    if (line.startsWith('+') && !line.startsWith('+++')) {
      // Added line occupies this new-file position; extend the run to include it.
      if (runStart === -1) runStart = newLine;
      runEnd = newLine;
      newLine++;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      // Deleted line consumes no new-file line, but marks a change at this spot.
      if (runStart === -1) runStart = newLine;
      runEnd = Math.max(runEnd, newLine);
    } else {
      // Context line: the run (if any) ended on the previous line.
      closeRun();
      newLine++;
    }
  }
  closeRun();
  return ranges.filter(([s, e]) => s > 0 && e >= s);
}

/** Whether any range overlaps [line - window, line + window]. */
export function rangesTouchLine(ranges: LineRange[], line: number, window = 3): boolean {
  const lo = line - window;
  const hi = line + window;
  return ranges.some(([s, e]) => e >= lo && s <= hi);
}
