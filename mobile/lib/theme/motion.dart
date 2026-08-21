import 'package:flutter/physics.dart';

/// The three precomputed springs from docs/DESIGN.md §11.3a -- nothing in
/// this app defines a `SpringDescription` inline. Flutter's
/// `SpringDescription.withDampingRatio` takes mass/stiffness/ratio, not
/// Apple's damping-ratio/response pair, so the response values from §11.3
/// are pre-converted here (omega = 2*pi/response, stiffness = omega^2,
/// mass = 1) rather than recomputed at each call site.
///
/// Do not use `AnimatedContainer`/`AnimatedOpacity`/`AnimatedPositioned`/
/// a fixed-`Duration` `CurvedAnimation` on any surface the user can touch --
/// they're non-interruptible and discard velocity. Drive gesture-driven
/// motion with `AnimationController.animateWith(SpringSimulation(...))`
/// seeded from the controller's current value and velocity instead.
class Motion {
  Motion._();

  // `withDampingRatio` is a factory (it computes damping = ratio * 2 *
  // sqrt(mass*stiffness) at call time), so these can only be `static
  // final`, not `static const` -- evaluated once, not a compile-time
  // constant.

  /// Default UI: appears, moves, repositions. damping 1.0, response 0.4.
  static final SpringDescription standard = SpringDescription.withDampingRatio(
    mass: 1,
    stiffness: 247,
    ratio: 1.0,
  );

  /// Momentum: after a flick or drag release. damping 0.8, response 0.4.
  static final SpringDescription momentum = SpringDescription.withDampingRatio(
    mass: 1,
    stiffness: 247,
    ratio: 0.8,
  );

  /// Sheets and drawers. damping 0.8, response 0.3.
  static final SpringDescription sheet = SpringDescription.withDampingRatio(
    mass: 1,
    stiffness: 439,
    ratio: 0.8,
  );
}
