import 'package:flutter/material.dart';

import '../services/api_client.dart';
import '../theme/type.dart';
import 'manual_check_screen.dart';

/// docs/DESIGN.md §11.8 screen 1. The band-card slip browser (swipe
/// between bands, spring-expanding legs) isn't built yet -- no
/// slip-builder backend exists (Task B5/B6 land the scoring and
/// settlement this depends on; the slip builder itself is unbuilt). This
/// is the real, honest empty state for that, not a stand-in for demo
/// data -- Amendment B7 removed demo mode entirely, so an unreachable
/// feature is a plain empty state, never fake slips.
///
/// This is also the home screen, so the one-tap path to Manual price
/// check (Task B4) lives here per docs/ARCHITECTURE.md's requirement
/// that it be "reachable in one tap from the home screen."
class SlipsScreen extends StatelessWidget {
  const SlipsScreen({super.key, required this.apiClient});

  final ApiClient apiClient;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Slips')),
      body: Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                'No slips built yet.',
                style: AppType.statNumber,
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 8),
              Text(
                'A slip only forms from strategies with 50+ settled selections and a positive '
                'roi_ci_low -- see the Health tab for how close any strategy is. In the meantime, '
                'check a real price against the sharp line yourself:',
                style: AppType.body,
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 24),
              FilledButton.icon(
                icon: const Icon(Icons.bolt),
                label: const Text('Manual price check'),
                onPressed: () {
                  Navigator.of(context).push(
                    MaterialPageRoute(builder: (_) => ManualCheckScreen(apiClient: apiClient)),
                  );
                },
              ),
            ],
          ),
        ),
      ),
    );
  }
}
