import 'package:flutter/material.dart';

/// Semantic result colors. Per docs/DESIGN.md §11.6 "Familiarity":
/// won/lost/void use conventional colour and are never distinguished by
/// colour alone -- always pair with [glyphFor]. No gradients anywhere
/// (§11.7 anti-defaults).
class AppColor {
  AppColor._();

  static const Color seed = Color(0xFF2E6B4F); // muted green, not a stock Material blue

  static const Color won = Color(0xFF1E8A4C);
  static const Color lost = Color(0xFFC0392B);
  static const Color voided = Color(0xFF8A8F98);
  static const Color pending = Color(0xFF8A8F98);

  static const Color positiveEdge = Color(0xFF1E8A4C);
  static const Color negativeEdge = Color(0xFFC0392B);
}

enum SettlementStatus { won, lost, voided, push, ungradeable, pending }

Color colorForStatus(SettlementStatus status) {
  switch (status) {
    case SettlementStatus.won:
      return AppColor.won;
    case SettlementStatus.lost:
      return AppColor.lost;
    case SettlementStatus.voided:
    case SettlementStatus.push:
    case SettlementStatus.ungradeable:
      return AppColor.voided;
    case SettlementStatus.pending:
      return AppColor.pending;
  }
}

/// Never rely on colour alone -- every status pairs with a glyph.
IconData glyphForStatus(SettlementStatus status) {
  switch (status) {
    case SettlementStatus.won:
      return Icons.check_circle;
    case SettlementStatus.lost:
      return Icons.cancel;
    case SettlementStatus.voided:
    case SettlementStatus.push:
      return Icons.remove_circle_outline;
    case SettlementStatus.ungradeable:
      return Icons.help_outline;
    case SettlementStatus.pending:
      return Icons.schedule;
  }
}
