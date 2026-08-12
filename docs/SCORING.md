## 7. Reliability scoring — the core of the product

Per source, per market class, per window:

```
ROI = (Σ (odds_used − 1) for wins − count(losses)) / count(settled)

odds_used = verified_odds if present else min(claimed_odds, market_odds)
```

- **Wilson score interval** on win rate; **bootstrap CI on ROI** (resample
  settled selections 2000×, take 5th/95th percentile). **Rank by `roi_ci_low`**,
  not point ROI — this buries small-sample flukes automatically.
- **Minimum sample gate:** under 50 settled selections in the window → `UNRATED`,
  cannot contribute to a slip. No exceptions. A 12-for-14 account is noise.
- **Decay:** weight recent results higher, half-life ~45 days.
- **Automatic disqualifiers:**
  - deleted-post rate above 5% of tracked posts
  - post-kickoff capture rate above 10%
  - claimed-odds inflation averaging over 8% above verified market odds
  - any tip posted after the result was known
- Track **longest losing run** and **max drawdown**. A 12% ROI account with a
  19-loss streak is a different product from a 12% ROI account with a 6-loss
  streak.

All of this is exposed in the app. The reliability screen is the reason to use
this over just reading the channels.

---

## Amendment B5 — repointed to strategies, CLV added as headline metric

**This section amends the verbatim §7 above; it does not replace it.** The
formula, the Wilson/bootstrap CIs, the `roi_ci_low` ranking, the 50-sample
gate, the decay, and the disqualifiers all carry over unchanged. What
changes is what gets scored and what's shown first. Full context and
reasoning: `docs/ARCHITECTURE.md` § "Scoring — repointed to strategies".

- **Grade strategies, not tipster accounts.** A strategy is a
  configuration — competition, market type, edge threshold, source book —
  produced by the odds-market value-detection engine (Amendment B),
  rather than a social-media account. `sources` in the schema and in this
  document's language becomes `strategies` wherever this applies; the
  original tipster-account schema and scoring path stay intact behind
  `sources.social.enabled` for whenever that path is re-enabled.
- **CLV is the headline metric, shown above ROI:**
  ```
  CLV = (odds_taken / closing_odds) − 1
  ```
  Report mean CLV and the share of bets with positive CLV, per strategy.
- **Beating the closing line consistently is the only fast evidence of a
  real edge.** ROI over 50 bets is mostly noise; CLV over 50 bets is real
  signal — this is *why* CLV leads, not a cosmetic reordering.
- **A strategy with good ROI but negative CLV got lucky.** Show that
  explicitly rather than letting a good-looking ROI stand alone — this is
  a required display rule, not a nice-to-have (see `docs/ARCHITECTURE.md`
  § "Scoring" and the mobile screens in `docs/DESIGN.md`).
- Everything in §8 (slip bands) and §9 (audit module) is unchanged by
  this amendment, except that slip legs must now be genuinely +EV (edge
  above the configured threshold) to enter a slip — combining legs with
  no edge just compounds the bookmaker's margin. The correlation guard
  matters more here, since correlated legs break the independence the
  edge calculation assumes.
