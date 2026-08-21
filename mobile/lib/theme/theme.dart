import 'package:flutter/material.dart';

import 'color.dart';

/// `ThemeData` structure ported from tradeapp's `theme.dart`
/// (docs/ARCHITECTURE.md "Patterns to port from tradeapp"), with one
/// deliberate omission: tradeapp's `accentGradient` (theme.dart:23-27) is
/// dropped -- gradients are on the anti-defaults list (§11.7).
ThemeData buildAppTheme() {
  final colorScheme = ColorScheme.fromSeed(seedColor: AppColor.seed);

  return ThemeData(
    useMaterial3: true,
    colorScheme: colorScheme,
    scaffoldBackgroundColor: colorScheme.surface,
    fontFamily: 'Roboto',
    // System font per §11.5: Roboto is Flutter's own default on Android
    // already; the fallback list is what matters for iOS (SF).
    fontFamilyFallback: const ['SF Pro Text', '.SF UI Text', 'Roboto'],
    appBarTheme: AppBarTheme(
      backgroundColor: Colors.transparent,
      elevation: 0,
      scrolledUnderElevation: 0,
      foregroundColor: colorScheme.onSurface,
    ),
    splashFactory: NoSplash.splashFactory,
  );
}
