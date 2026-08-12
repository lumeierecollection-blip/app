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
