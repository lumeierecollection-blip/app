import 'package:flutter/material.dart';

import '../services/api_client.dart';
import '../theme/type.dart';

/// Task B4 -- the manual price check screen, reachable in one tap from
/// the home screen (Slips). Pick a fixture/market, see the fair price,
/// type in what your own bookmaker offers, get the edge and stake
/// recommendation back.
///
/// Simplified from the full brief for this first cut: fixture/market/pick
/// are typed in directly rather than picked from a fixture browser (no
/// fixture-list backend endpoint exists yet -- only the fair-price and
/// manual-check endpoints from Task B4 are built), and price entry uses
/// the OS numeric keyboard rather than a custom large-keypad widget.
/// Flagged in docs/STATUS.md as a real simplification, not a stand-in for
/// fake data -- every number on this screen is real, computed live from
/// the sharp-book price stored in Postgres.
class ManualCheckScreen extends StatefulWidget {
  const ManualCheckScreen({super.key, required this.apiClient});

  final ApiClient apiClient;

  @override
  State<ManualCheckScreen> createState() => _ManualCheckScreenState();
}

class _ManualCheckScreenState extends State<ManualCheckScreen> {
  final _fixtureIdController = TextEditingController();
  final _marketController = TextEditingController(text: 'moneyline');
  final _pickController = TextEditingController(text: 'home');
  final _oddsController = TextEditingController();
  final _bookmakerController = TextEditingController();

  FairPrice? _fairPrice;
  ManualCheckResult? _result;
  String? _error;
  bool _loadingFairPrice = false;
  bool _submitting = false;

  @override
  void dispose() {
    _fixtureIdController.dispose();
    _marketController.dispose();
    _pickController.dispose();
    _oddsController.dispose();
    _bookmakerController.dispose();
    super.dispose();
  }

  Future<void> _loadFairPrice() async {
    setState(() {
      _loadingFairPrice = true;
      _error = null;
      _fairPrice = null;
      _result = null;
    });
    try {
      final fairPrice = await widget.apiClient.fetchFairPrice(
        fixtureId: _fixtureIdController.text.trim(),
        market: _marketController.text.trim(),
      );
      setState(() => _fairPrice = fairPrice);
    } catch (e) {
      setState(() => _error = 'Could not load the fair price: $e');
    } finally {
      setState(() => _loadingFairPrice = false);
    }
  }

  Future<void> _submit() async {
    final oddsText = _oddsController.text.trim();
    final entered = double.tryParse(oddsText);
    if (entered == null || entered <= 1.0) {
      setState(() => _error = 'Enter real decimal odds greater than 1.0.');
      return;
    }
    setState(() {
      _submitting = true;
      _error = null;
    });
    try {
      final result = await widget.apiClient.submitManualCheck(
        fixtureId: _fixtureIdController.text.trim(),
        market: _marketController.text.trim(),
        pick: _pickController.text.trim(),
        enteredOdds: entered,
        enteredBookmaker: _bookmakerController.text.trim(),
      );
      setState(() => _result = result);
    } catch (e) {
      setState(() => _error = 'Could not submit the check: $e');
    } finally {
      setState(() => _submitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Manual price check')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          TextField(
            controller: _fixtureIdController,
            decoration: const InputDecoration(labelText: 'Fixture ID'),
          ),
          const SizedBox(height: 8),
          TextField(
            controller: _marketController,
            decoration: const InputDecoration(labelText: 'Market (e.g. moneyline)'),
          ),
          const SizedBox(height: 8),
          TextField(
            controller: _pickController,
            decoration: const InputDecoration(labelText: 'Pick (e.g. home / draw / away)'),
          ),
          const SizedBox(height: 16),
          FilledButton(
            onPressed: _loadingFairPrice ? null : _loadFairPrice,
            child: Text(_loadingFairPrice ? 'Loading fair price...' : 'Show fair price'),
          ),
          if (_fairPrice != null) ...[
            const SizedBox(height: 16),
            const Text('Fair prices (sharp book, de-vigged)', style: AppType.label),
            const SizedBox(height: 8),
            for (final entry in _fairPrice!.fairPrices.entries)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 4),
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Text(entry.key, style: AppType.body),
                    Text(entry.value.toStringAsFixed(2), style: AppType.tableNumber),
                  ],
                ),
              ),
            const Divider(height: 32),
            TextField(
              controller: _bookmakerController,
              decoration: const InputDecoration(labelText: 'Your bookmaker'),
            ),
            const SizedBox(height: 8),
            TextField(
              controller: _oddsController,
              keyboardType: const TextInputType.numberWithOptions(decimal: true),
              decoration: const InputDecoration(labelText: 'Odds they are offering'),
              style: AppType.displayNumber,
            ),
            const SizedBox(height: 16),
            FilledButton(
              onPressed: _submitting ? null : _submit,
              child: Text(_submitting ? 'Checking...' : 'Check edge'),
            ),
          ],
          if (_result != null) ...[
            const SizedBox(height: 24),
            _ManualCheckResultCard(result: _result!),
          ],
          if (_error != null) ...[
            const SizedBox(height: 16),
            Text(_error!, style: const TextStyle(color: Colors.red)),
          ],
        ],
      ),
    );
  }
}

class _ManualCheckResultCard extends StatelessWidget {
  const _ManualCheckResultCard({required this.result});

  final ManualCheckResult result;

  @override
  Widget build(BuildContext context) {
    if (!result.passedGates) {
      return Card(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text('Rejected by sanity gates', style: AppType.statNumber),
              const SizedBox(height: 8),
              for (final reason in result.rejections) Text('- $reason', style: AppType.body),
            ],
          ),
        ),
      );
    }
    final edgePct = (result.edge * 100).toStringAsFixed(1);
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Edge: $edgePct%', style: AppType.displayNumber),
            const SizedBox(height: 8),
            Text('Fair odds: ${result.fairOdds.toStringAsFixed(2)}', style: AppType.body),
            if (result.stakeFraction != null)
              Text(
                'Suggested stake: ${(result.stakeFraction! * 100).toStringAsFixed(1)}% of bankroll',
                style: AppType.body,
              ),
          ],
        ),
      ),
    );
  }
}
