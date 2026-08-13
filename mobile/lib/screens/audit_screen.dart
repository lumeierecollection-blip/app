import 'package:flutter/material.dart';

import '../theme/type.dart';

/// docs/DESIGN.md §11.8 screen 5. Prose typography, not a dashboard --
/// this screen is an argument, not a table. Separate pipeline from the
/// slip builder; never renders a prediction as actionable
/// (docs/ARCHITECTURE.md "Audit module"). No `audit_calls` ingestion or
/// scoring exists yet, so this is a real empty state.
class AuditScreen extends StatelessWidget {
  const AuditScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Audit')),
      body: Padding(
        padding: const EdgeInsets.all(24),
        child: Text(
          'No accounts audited yet.\n\n'
          'This screen will report what fraction of a claimed-signal account\'s calls '
          '(Aviator, virtual matches) are even verifiable, and how its hit rate compares to '
          'chance under the game\'s stated RTP. It never builds a slip and never presents a '
          'finding here as an actionable prediction.',
          style: AppType.body,
        ),
      ),
    );
  }
}
