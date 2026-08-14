/**
 * Amendment E -- the §7 source-level disqualifiers, wired to real data
 * (Task E5). The brief defines them all in terms of a *post*: deleted-post
 * rate, post-kickoff capture rate, claimed-odds inflation, and
 * posted-after-result. The scoring engine (lib/scoring.js) is the proven
 * ROI/CLV math and is left untouched -- these checks are computed here,
 * from store-side aggregates, and written onto the source_scores row the
 * notification gate reads.
 *
 * Computed now (real data exists for each):
 *  - post-kickoff capture rate > 10% (captureStats: all selections)
 *  - claimed-odds inflation averaging > 8% above verified (avgOddsInflation)
 *  - any gradeable selection posted > 120 min after kickoff
 *    (postTimingStats -- the "after the result was known" proxy; documented
 *    approximation since the exact result time isn't stored)
 *
 * Not computed yet (no data captured for it): deleted-post rate -- deletion
 * is not observed by the poller. Needs a future edit/history-delta
 * detection step; flagged in docs/STATUS.md.
 */

export const CAPTURE_RATE_MAX = 0.10;
export const ODDS_INFLATION_MAX = 0.08;
export const RESULT_GRACE_MINUTES = 120;

/** Returns the list of disqualification reasons for a source ([] = clean). */
export function disqualificationsForSource(store, sourceId) {
  const reasons = [];

  const capture = store.captureStats(sourceId);
  if (capture.total > 0) {
    const missedRate = 1 - capture.gradeable / capture.total;
    if (missedRate > CAPTURE_RATE_MAX) {
      reasons.push(
        `post-kickoff capture rate ${(missedRate * 100).toFixed(1)}% exceeds ${CAPTURE_RATE_MAX * 100}% ` +
          `(${capture.total - capture.gradeable} of ${capture.total} selections captured at/after kickoff)`,
      );
    }
  }

  const inflation = store.avgOddsInflation(sourceId);
  if (inflation !== null && inflation > ODDS_INFLATION_MAX) {
    reasons.push(
      `claimed odds average ${(inflation * 100).toFixed(1)}% above verified — exceeds ${ODDS_INFLATION_MAX * 100}%`,
    );
  }

  const timing = store.postTimingStats(sourceId, { resultGraceMs: RESULT_GRACE_MINUTES * 60 * 1000 });
  if (timing.afterResult > 0) {
    reasons.push(
      `${timing.afterResult} gradeable selection${timing.afterResult > 1 ? 's' : ''} posted > ${RESULT_GRACE_MINUTES} min after kickoff`,
    );
  }

  return reasons;
}

/** True when a source should receive push notifications: rated (>= 50
 * settled) AND roi_ci_low > 0 AND not disqualified. */
export function sourceIsNotifiable(latestAllWindowScore) {
  if (!latestAllWindowScore) return false;
  if (latestAllWindowScore.disqualified) return false;
  return latestAllWindowScore.n_settled >= 50 && latestAllWindowScore.roi_ci_low !== null && latestAllWindowScore.roi_ci_low > 0;
}
