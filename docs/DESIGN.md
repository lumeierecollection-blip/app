## 11. Mobile design brief

### 11.1 Design authority

**Load `.claude/skills/apple-design/SKILL.md` before writing any UI code and
follow it as the design authority.** It governs motion, materials, typography,
and design foundations. Do not substitute your own defaults for anything it
specifies. Use `pick-ui-library` before hand-rolling any component.

That skill is written for the web (CSS, `backdrop-filter`, Pointer Events).
§11.3–11.5 below translate it to Flutter (Amendment C — the mobile framework
switched from Expo/React Native to Flutter before any mobile code existed;
see `CLAUDE.md` and `docs/ARCHITECTURE.md` § "Build and delivery — the APK"
for why). **The principles are unchanged; only the APIs differ.** Where the
skill names a CSS technique, use the Flutter equivalent given here — never
conclude the principle doesn't apply because the CSS property doesn't exist.
§11.3a below is a denser, addendum-style translation layered on top of
§11.3, covering the traps that break under a naive Flutter port
specifically — read both.

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

One `mobile/theme/motion.dart` token file. No widget defines a spring inline.

Apple's spring model is damping ratio + response (seconds) — the same pair
Reanimated would have accepted directly. **Flutter's `SpringDescription`
does not take that pair**; it takes `mass`, `stiffness`, and `ratio`, so
response has to be converted to stiffness first. The full conversion,
precomputed values, and the traps specific to a Flutter port are in
§11.3a — read it before writing `motion.dart`. The principles below are
unchanged from the original (framework-agnostic) design brief:

- **Default: critically damped, no overshoot.** Damping ratio 1.0,
  response 0.4s — precomputed Flutter form in §11.3a. This is the house
  default for anything that appears, moves, or repositions without the
  user having thrown it.
- **Bounce only after momentum.** Damping ratio 0.8 is permitted *only*
  when a flick or drag-release preceded the motion — a dismissed sheet, a
  swiped card. Never on a panel that merely opened.
- **Sheets/drawers:** damping ratio 0.8, response 0.3s.
- **Hand off release velocity on every gesture-driven animation.** Take
  the drag-end velocity from the gesture callback and pass it into the
  spring simulation — see §11.3a for the exact Flutter pattern
  (`AnimationController.animateWith(SpringSimulation(...))`, seeded from
  velocity, not from the target). A sheet that closes at a fixed speed
  regardless of flick strength is a bug, not a style choice.
- **Momentum projection for snap targets.** On release, project the resting point
  from velocity using the exponential-decay form in the skill
  (`decelerationRate ≈ 0.998`), then snap to the nearest detent from the
  *projection* — not from the release position. The decay math is pure Dart;
  port it unchanged.
- **Commit-vs-reverse uses the velocity sign at release, not position.** A sheet
  dragged 80% closed but flicked upward reopens.
- **Interruptibility is a hard requirement.** A spring simulation re-targets
  from the controller's live value and velocity — preserve that. Never gate
  touches during a transition. **Never use Flutter's implicit animation
  widgets (`AnimatedContainer`, `AnimatedOpacity`, `AnimatedPositioned`,
  `CurvedAnimation` with a fixed `Duration`) for anything the user can
  grab** — they're fixed-duration, non-interruptible, and discard
  velocity; full reasoning in §11.3a.
- **Press feedback on press-in, not on release:** `scale(0.97)`, ~100ms, on every
  pressable including table rows. Use `GestureDetector.onTapDown`, not `onTap`.
- Animate transform and opacity only. Keep animation driven by
  `AnimationController`, never by rebuilding from arbitrary widget state.

### 11.3a Flutter translation addendum

Everything in §11 stands; this makes the translation exact. Load
`.claude/skills/apple-design/SKILL.md` alongside it. The principles are
unchanged. Four things break under a naive port, and one number needs
converting.

**1. The response → stiffness conversion (do this right).** Apple's
spring model is damping ratio + response (seconds). Reanimated would
have accepted that pair directly. **Flutter does not** —
`SpringDescription.withDampingRatio` takes `mass`, `stiffness`, and
`ratio`. Response has to be converted:

```
ω = 2π / response
stiffness = ω² × mass        // mass = 1
```

Precomputed from §11.3's values. Put these in `theme/motion.dart` and
use nothing else:

| Use | Apple values | Flutter |
|---|---|---|
| **Default UI** — appears, moves, repositions | damping 1.0, response 0.4 | `SpringDescription.withDampingRatio(mass: 1, stiffness: 247, ratio: 1.0)` |
| **Momentum** — after a flick or drag release | damping 0.8, response 0.4 | `…(mass: 1, stiffness: 247, ratio: 0.8)` |
| **Sheets / drawers** | damping 0.8, response 0.3 | `…(mass: 1, stiffness: 439, ratio: 0.8)` |

`ratio` maps 1:1 onto Apple's damping ratio — no conversion needed there.

**2. Implicit animations are the trap.** This is the one most likely to
quietly destroy the design. Flutter's idiomatic path is
`AnimatedContainer`, `AnimatedOpacity`, `AnimatedPositioned`,
`CurvedAnimation` with a fixed `Duration`. **All of them are
fixed-duration and non-interruptible in the way §11.3 requires.** They
run to completion, restart from zero when re-targeted, and discard
velocity. Use them and the app will look animated while feeling dead —
the exact failure the skill's "interruptibility is the single most
important principle" section is about.

**Rule: no `Animated*` widget on any surface the user can touch.** Use
`AnimationController` + `animateWith(SpringSimulation(...))`, seeding the
simulation from the controller's **current value and current velocity**,
never from the target.

Implicit animations are fine for non-interactive, non-gestural state
changes — a colour shift, a static fade. Nothing draggable.

**3. Velocity handoff.** Flutter gives you this cleanly, so there's no
excuse for skipping it:

```dart
onPanEnd: (DragEndDetails d) {
  final v = d.velocity.pixelsPerSecond.dy;
  controller.animateWith(
    SpringSimulation(motion.sheet, controller.value, target, v),
  );
}
```

Match the velocity's units to the value space the controller animates
in — if the controller runs 0→1 over a sheet height, divide pixel
velocity by that height first. Getting this wrong produces springs that
look violently wrong on fast flicks and is the most common bug here.

For **momentum projection** (§11.6 of the skill), the decay math is pure
Dart — port it unchanged. For scroll edges, `BouncingScrollPhysics`
gives you §9's rubber-banding for free; only hand-roll it for custom
drag surfaces.

**4. `BackdropFilter` is expensive — budget it.** `BackdropFilter` +
`ImageFilter.blur` is the `backdrop-filter` equivalent and it works, but
in Flutter it's genuinely costly and **nested blurs compound badly**.

- One blurred layer visible at a time. A blurred sheet over a blurred
  header is both a performance problem and a §12 violation (never stack
  two light translucent surfaces).
- Wrap in `RepaintBoundary`.
- There's no `saturate()` — the skill's `saturate(180%)` needs
  `ColorFilter.matrix` if you want it. Optional; the blur carries most of
  it.
- Profile on your actual phone, not a flagship. If the Slips screen
  drops frames while scrolling under the header, the header goes solid.
  Legibility and smoothness beat the material effect.

**5. Accessibility — one real gap.**

| Skill signal | Flutter |
|---|---|
| `prefers-reduced-motion` | `MediaQuery.of(context).disableAnimations` ✅ |
| `prefers-contrast: more` | `MediaQuery.of(context).highContrast` ✅ |
| `prefers-reduced-transparency` | **No equivalent** ⚠️ |

Flutter exposes no reduced-transparency signal. Add an in-app setting —
"Reduce transparency" in Admin — that switches every `BackdropFilter`
surface to solid. Default it off, wire it through the same code path the
system flags use, and treat a low-end device as a reason to turn it on.

**6. Everything else maps directly.**

- **Press feedback on press-down**: `GestureDetector.onTapDown` →
  `scale(0.97)`, ~100ms. Not `onTap`. Applies to list rows too.
- **1:1 drag with grab offset**: `onPanStart` gives you `localPosition` —
  store the offset, don't recentre on the pointer.
- **Spatial consistency (§7)**: `showModalBottomSheet` will *not* anchor
  to the tapped row. Use a custom `PageRouteBuilder` with a
  `Transform.scale` whose `alignment` is derived from the row's position,
  or a `Hero`. This takes real work — don't skip it, it's what makes the
  sheet feel connected to the row.
- **Typography**: `FontFeature.tabularFigures()` on every numeric style,
  `letterSpacing` negative on display sizes and near 0 for body, `height`
  for leading, `MediaQuery.textScaler` respected so layout scales with
  the OS font setting.
- **Haptics**: `HapticFeedback.selectionClick()` / `.lightImpact()`.
  Android's are coarser than iOS — §13's *utility* rule matters more
  here, so reserve them for commit and snap moments only.
- **Sections 1, 8, 10, 11, 16, 17** are framework-agnostic. They apply
  verbatim.

**Definition of done for this addendum:**

- `theme/motion.dart` holds the three springs above and nothing defines
  one inline.
- No `Animated*` widget appears on a gesture-driven surface.
- Every drag release passes real velocity into the simulation, in
  matched units.
- At most one blurred layer is visible at any time.
- The reduce-transparency setting exists and works.
- Sheets animate from the element that opened them.
- Every numeric style uses tabular figures.

### 11.4 Materials and depth

- Header and band selector are **translucent** — `BackdropFilter` +
  `ImageFilter.blur` over a semi-transparent background, with content
  scrolling underneath. Not opaque bars eating a fixed strip of a
  data-dense screen. `BackdropFilter` is genuinely expensive in Flutter
  and nested blurs compound badly — budget and profiling detail in
  §11.3a.
- **Never stack two light translucent surfaces** — at most one blurred
  layer visible at any time. A sheet over a translucent header requires
  the sheet to be the heavier material (typically solid, not blurred).
- **Scroll edge fade, not a 1px divider**, where content passes under floating
  chrome. Use a gradient mask (`ShaderMask`).
- **Sheets materialize** — animate blur intensity and scale together on enter, so
  the surface arrives as a material rather than fading in.
- Modal sheets (source detail) get a dimming scrim and push the background back.
  Non-blocking panels (filters) get translucency and offset with **no scrim** —
  the user is still reading the table behind them.
- **Reduce-transparency has no OS-level signal in Flutter** (unlike
  reduce-motion and high-contrast, which do). Add an in-app "Reduce
  transparency" setting in Admin that switches every `BackdropFilter`
  surface to solid, default off — full detail in §11.3a. Wire it through
  the same code path as the OS-level flags below so both routes land in
  one place.

### 11.5 Typography

- **System font** (SF on iOS, Roboto on Android — Flutter's platform default,
  with `fontFamilyFallback` covering both) as the base. It ships optical sizing
  and tracking tables already. Override only with a stated reason.
- **Size-specific tracking.** Large numbers — a slip's combined odds — take
  negative `letterSpacing` (~-0.5 at 40px) and tight `height` (Flutter's line-height
  equivalent). Body and table text sit near 0. A single global letter-spacing
  value is wrong somewhere by definition.
- **Tabular figures are mandatory** on every odds, percentage, ROI, and count:
  `fontFeatures: [FontFeature.tabularFigures()]` in the `TextStyle`. Columns
  must not shift width as values update. This is the most visible craft
  failure in a betting UI. (Checked against `tradeapp`'s `theme.dart`: it
  applies this to exactly one style, `clockStyle` — every numeric style needs
  it here, not just one.)
- Hierarchy from weight + size + leading as a set, not size alone.
- Respect `MediaQuery.textScaler` (the OS font-scale setting); size spacing
  relative to type, not fixed, so large text doesn't break the layout.

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
