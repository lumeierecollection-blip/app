import 'package:flutter/material.dart';

import '../theme/type.dart';

/// docs/DESIGN.md §11.8 screen 2, tab label kept as "Tipsters" per
/// docs/ARCHITECTURE.md's App shell section even though the underlying
/// data is now strategy_scores (Amendment B repoints scoring from
/// tipster accounts to strategies; the tab label wasn't amended). CLV is
/// the headline metric above ROI once this table has real data
/// (Amendment B5) -- no backend list endpoint for strategy_scores exists
/// yet, so this is a real empty state, not a fabricated table.
class TipstersScreen extends StatelessWidget {
  const TipstersScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Tipsters')),
      body: Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Text(
            'No strategies rated yet.\n\nA strategy needs 50 settled selections before it is '
            'rated -- see the Health tab for ingestion status in the meantime.',
            style: AppType.body,
            textAlign: TextAlign.center,
          ),
        ),
      ),
    );
  }
}
