## 11. Mobile design brief

### 11.1 Design authority

**Load `.claude/skills/apple-design/SKILL.md` before writing any UI code and
follow it as the design authority.** It governs motion, materials, typography,
and design foundations. Do not substitute your own defaults for anything it
specifies. Use `pick-ui-library` before hand-rolling any component.

That skill is written for the web (CSS, `backdrop-filter`, Pointer Events).
§11.3–11.5 below translate it to React Native. **The principles are unchanged;
only the APIs differ.** Where the skill names a CSS technique, use the RN
equivalent given here — never conclude the principle doesn't apply because the
CSS property doesn't exist.

### 11.2 Where to follow it fully, and where to hold back

That skill targets gesture-driven touch interfaces. This is also a **dense data
product**. Both are true and the tension must be resolved deliberately:

**Follow fully on:**
- Every surface the user physically touches — slip cards expanding, source-detail
  sheets, pull-to-refresh, swipe actions in the review queue, band switching.
- All motion physics: springs, interruptibility, velocity handoff, momentum
  projection, rubber-banding at scroll edges.
- Materials and depth for chrome.
- All typography rules.
- All reduced-motion and accessibility handling.
- All eight design foundations, especially Craft and Simplicity.

**Deliberately still in the data views:**
- **Do not animate list rows on data change.** A 200-row tipster table with
  staggered spring entrances is motion for its own sake — the skill's own Utility
  and Simplicity rules forbid it.
- **Never animate a number that carries meaning.** An ROI figure counting up from
  zero makes the reader wait to learn something.
- Reserve full gesture treatment for things the user grabs. Everything else stays
  still and legible.

Put this in code comments where it applies, so a later session doesn't "fix" the
stillness by adding animation.

### 11.3 Motion system — concrete, non-negotiable

One `mobile/theme/motion.ts` token file. No component defines a spring inline.

Reanimated 3's `withSpring` accepts `dampingRatio` and `duration`, which map
directly onto Apple's damping/response model — use that form, not
mass/stiffness.

- **Default: critically damped, no overshoot.**
  `withSpring(target, { dampingRatio: 1, duration: 400 })`. This is the house
  default for anything that appears, moves, or repositions without the user
  having thrown it.
- **Bounce only after momentum.** `dampingRatio: 0.8` is permitted *only* when a
  flick or drag-release preceded the motion — a dismissed sheet, a swiped card.
  Never on a panel that merely opened.
- **Sheets/drawers:** `dampingRatio: 0.8`, `duration: 300`.
- **Hand off release velocity on every gesture-driven animation.** Take
  `event.velocityY` from the gesture handler's `onEnd` and pass it as the spring's
  `velocity`. A sheet that closes at a fixed speed regardless of flick strength is
  a bug, not a style choice.
- **Momentum projection for snap targets.** On release, project the resting point
  from velocity using the exponential-decay form in the skill
  (`decelerationRate ≈ 0.998`), then snap to the nearest detent from the
  *projection* — not from the release position.
- **Commit-vs-reverse uses the velocity sign at release, not position.** A sheet
  dragged 80% closed but flicked upward reopens.
- **Interruptibility is a hard requirement.** Reanimated springs re-target from
  the live shared value — preserve that. Never gate touches during a transition.
  Never use `withTiming` for anything the user can grab.
- **Press feedback on press-in, not on release:** `scale(0.97)`, ~100ms, on every
  pressable including table rows. Use `Pressable`'s `onPressIn`.
- Animate transform and opacity only. Keep all animation in worklets on the UI
  thread — never drive it from React state.

### 11.4 Materials and depth

- Header and band selector are **translucent** — `expo-blur` `BlurView` over a
  semi-transparent background, with content scrolling underneath. Not opaque bars
  eating a fixed strip of a data-dense screen.
- **Never stack two light translucent surfaces.** A sheet over a translucent
  header requires the sheet to be the heavier material.
- **Scroll edge fade, not a 1px divider**, where content passes under floating
  chrome. Use a gradient mask.
- **Sheets materialize** — animate blur intensity and scale together on enter, so
  the surface arrives as a material rather than fading in.
- Modal sheets (source detail) get a dimming scrim and push the background back.
  Non-blocking panels (filters) get translucency and offset with **no scrim** —
  the user is still reading the table behind them.
- Honour `AccessibilityInfo.isReduceTransparencyEnabled()`: solid backgrounds,
  blur off.

### 11.5 Typography

- **System font** (`System` / SF on iOS, Roboto on Android) as the base. It ships
  optical sizing and tracking tables already. Override only with a stated reason.
- **Size-specific tracking.** Large numbers — a slip's combined odds — take
  negative `letterSpacing` (~-0.5 at 40px) and tight `lineHeight`. Body and table
  text sit near 0. A single global letter-spacing value is wrong somewhere by
  definition.
- **Tabular figures are mandatory** on every odds, percentage, ROI, and count:
  `fontVariant: ['tabular-nums']`. Columns must not shift width as values update.
  This is the most visible craft failure in a betting UI.
- Hierarchy from weight + size + leading as a set, not size alone.
- Respect the OS font-scale setting; size spacing relative to type, not fixed, so
  large text doesn't break the layout.

### 11.6 Foundations applied to this product

- **Responsibility (skill §16.3) is load-bearing here.** This app surfaces
  gambling selections. The margin figure and true-probability line on Band D and
  E slips are **not garnish, they are the safety surface** — legible at a glance,
  in the same weight class as the combined-odds number. If a layout makes the
  odds bigger and the margin smaller, that layout is wrong.
- **Agency.** No auto-placed bets, no deep links that pre-fill a stake. The app
  informs; the user decides. Always show the singles alternative.
- **Familiarity.** Won/lost/void use conventional semantic colour and are never
  distinguished by colour alone — always pair with a glyph.
- **Wayfinding.** Every number is traceable. A slip leg is one tap from the
  source account and that account's full record.
- **Simplicity, not minimalism.** Do not hide sample size or disqualifier flags to
  make a table look clean. Showing `n` beside an ROI figure *simplifies* it — the
  reader stops having to wonder.
- **Direct labels.** Tabs read "Slips", "Tipsters", "Audit" — not "Home",
  "Explore", "More".

### 11.7 Anti-defaults — reject on sight

The generated-app look comes from unexamined defaults. None of these appear here:

- Gradient headers; purple-to-indigo anything
- Heavy drop shadows as the primary depth cue — depth comes from material weight
- Uniform large-radius cards floating on a light grey background
- Emoji in section headings or empty states
- Three equal-width cards in a row
- Fade-up-with-stagger on mount
- Numbers that count up
- Stock empty-state illustrations
- A chart library's default palette and gridlines

### 11.8 Screens

1. **Slips** — five band cards. Combined odds is the display type; margin and true
   probability sit directly beneath at readable weight. Legs expand in place with
   a spring, not a navigation. Swipe between bands with 1:1 tracking and momentum
   projection to snap.
2. **Tipsters** — dense sortable table: ROI (CI low), n settled, avg odds, longest
   losing run, disqualifier flags. Still and fast. Press-in feedback only.
3. **Tipster detail** — opens as a sheet anchored to the tapped row (spatial
   consistency). Equity curve, full tip history, every settlement.
4. **Review queue** — low-confidence extractions. Swipe to accept/reject with
   rubber-banded boundaries and velocity-based commit.
5. **Audit** — Aviator/virtuals findings. Prose typography, not a dashboard. This
   screen is an argument; let it read like one.
6. **Admin** — sources, alias table, manual paste input.
