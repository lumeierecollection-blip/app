import 'package:flutter/material.dart';

import '../services/api_client.dart';
import '../theme/color.dart';
import '../theme/type.dart';

/// docs/DESIGN.md §11.8 screen 2, tab label kept as "Tipsters". Amendment E
/// repoints this at the backend's /api/sources -- the tracked Telegram
/// channels with their all-window score (ROI ranked, CLV headline, the
/// 50-settled gate marking a source rated, disqualifier reasons shown when
/// present). An empty list is the real state of a server that has ingested
/// nothing yet -- never a fabricated table (Amendment B7 removed demo mode).
class TipstersScreen extends StatefulWidget {
  const TipstersScreen({super.key, required this.apiClient});

  final ApiClient apiClient;

  @override
  State<TipstersScreen> createState() => _TipstersScreenState();
}

class _TipstersScreenState extends State<TipstersScreen> {
  late Future<List<SourceChannel>> _future;

  @override
  void initState() {
    super.initState();
    _future = widget.apiClient.fetchSources();
  }

  Future<void> _reload() async {
    setState(() => _future = widget.apiClient.fetchSources());
    await _future;
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Tipsters')),
      body: FutureBuilder<List<SourceChannel>>(
        future: _future,
        builder: (context, snapshot) {
          if (snapshot.connectionState != ConnectionState.done) {
            return const Center(child: CircularProgressIndicator());
          }
          if (snapshot.hasError) {
            return Center(
              child: Padding(
                padding: const EdgeInsets.all(24),
                child: Text('Could not load sources: ${snapshot.error}', style: AppType.body),
              ),
            );
          }
          final sources = snapshot.data ?? const [];
          if (sources.isEmpty) {
            return const Center(
              child: Padding(
                padding: EdgeInsets.all(24),
                child: Text(
                  'No sources tracked yet.\n\nCheck the Health tab for Telegram ingestion '
                  'status -- a source needs 50 settled selections before it is rated.',
                  style: AppType.body,
                  textAlign: TextAlign.center,
                ),
              ),
            );
          }
          return RefreshIndicator(
            onRefresh: _reload,
            child: ListView.builder(
              physics: const AlwaysScrollableScrollPhysics(),
              itemCount: sources.length,
              itemBuilder: (context, i) => _SourceCard(channel: sources[i]),
            ),
          );
        },
      ),
    );
  }
}

class _SourceCard extends StatelessWidget {
  const _SourceCard({required this.channel});

  final SourceChannel channel;

  @override
  Widget build(BuildContext context) {
    final score = channel.score;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    channel.displayName,
                    style: AppType.statNumber,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
                _Badge(score: score),
              ],
            ),
            if (score == null) ...[
              const SizedBox(height: 8),
              const Text('Not rated yet - waiting for the first settled selections.',
                  style: AppType.body),
            ] else ...[
              const SizedBox(height: 12),
              _StatRow(
                cells: [
                  ('ROI', _pct(score.roi)),
                  ('CLV', _pct(score.meanClv)),
                  ('Hit', _pct(score.hitRate)),
                  ('Bets', '${score.nSettled}'),
                ],
              ),
              if (score.disqualified && score.disqualificationReasons.isNotEmpty) ...[
                const SizedBox(height: 8),
                Text(
                  score.disqualificationReasons.join('\n'),
                  style: AppType.body.copyWith(color: AppColor.lost),
                ),
              ],
            ],
          ],
        ),
      ),
    );
  }

  static String _pct(double? value) => value == null ? '-' : '${(value * 100).toStringAsFixed(1)}%';
}

class _StatRow extends StatelessWidget {
  const _StatRow({required this.cells});

  final List<(String, String)> cells;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: cells
          .map((cell) => Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(cell.$1.toUpperCase(), style: AppType.label),
                    Text(cell.$2, style: AppType.statNumber),
                  ],
                ),
              ))
          .toList(),
    );
  }
}

class _Badge extends StatelessWidget {
  const _Badge({required this.score});

  final ChannelScore? score;

  @override
  Widget build(BuildContext context) {
    if (score == null) {
      return _chip('TRACKING', AppColor.voided);
    }
    if (score.disqualified) {
      return _chip('DISQUALIFIED', AppColor.lost);
    }
    if (score.rated && (score.roiCiLow ?? 0) > 0) {
      return _chip('RATED', AppColor.won);
    }
    return _chip('UNRATED', AppColor.voided);
  }

  Widget _chip(String label, Color color) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.15),
        borderRadius: BorderRadius.circular(12),
      ),
      child: Text(label, style: AppType.label.copyWith(color: color)),
    );
  }
}
