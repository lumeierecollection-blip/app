import 'package:flutter/material.dart';

/// Numeric text styles. Tabular figures are mandatory on every odds,
/// percentage, ROI, and count (docs/DESIGN.md §11.5) -- tradeapp's
/// theme.dart only applied this to one style (`clockStyle`); every
/// numeric style here needs it, not just one.
class AppType {
  AppType._();

  static const _tabular = [FontFeature.tabularFigures()];

  /// A slip's combined odds, or another large display number.
  static const TextStyle displayNumber = TextStyle(
    fontSize: 40,
    fontWeight: FontWeight.w700,
    letterSpacing: -0.5,
    height: 1.05,
    fontFeatures: _tabular,
  );

  /// ROI, edge, CLV, hit rate figures in a table or card.
  static const TextStyle statNumber = TextStyle(
    fontSize: 20,
    fontWeight: FontWeight.w600,
    letterSpacing: -0.1,
    height: 1.1,
    fontFeatures: _tabular,
  );

  /// Odds and counts inline in dense table rows.
  static const TextStyle tableNumber = TextStyle(
    fontSize: 15,
    fontWeight: FontWeight.w500,
    letterSpacing: 0,
    height: 1.2,
    fontFeatures: _tabular,
  );

  static const TextStyle body = TextStyle(
    fontSize: 15,
    fontWeight: FontWeight.w400,
    letterSpacing: 0,
    height: 1.3,
  );

  static const TextStyle label = TextStyle(
    fontSize: 12,
    fontWeight: FontWeight.w500,
    letterSpacing: 0.1,
    height: 1.2,
  );
}
