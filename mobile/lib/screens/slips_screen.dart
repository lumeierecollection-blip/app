import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../services/api_client.dart';
import '../services/feed.dart';
import '../services/settings.dart';
import '../theme/type.dart';

/// docs/DESIGN.md §11.8 screen 1, the home screen -- renamed "Feed" since it
/// now accumulates everything, tradeapp-style: Telegram + Reddit tips first
/// (newest first), then clearly-labeled context (football news RSS, ESPN
/// fixtures). Cloud backend wins when configured; on-device scan is the
/// fallback and the default. Raw text of every row is shown; nothing is
/// fabricated behind it.
class SlipsScreen extends StatefulWidget {
  const SlipsScreen({super.key, required this.apiClient, this.loader});

  final ApiClient apiClient;

  /// Injectable for tests; defaults to the real loader (cloud-first,
  /// on-device fallback).
  final FeedLoader? loader;

  @override
  State<SlipsScreen> createState() => _SlipsScreenState();
}

class _SlipsScreenState extends State<SlipsScreen> {
  late final FeedLoader _loader = widget.loader ?? FeedLoader();
  Future<FeedResult>? _future;
  String _signature = '';

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final settings = context.watch<AppSettings>();
    if (_future == null || settings.feedSignature != _signature) {
      _signature = settings.feedSignature;
      _reload();
    }
  }

  void _reload() {
    final settings = context.read<AppSettings>();
    final future = _loader.load(settings, widget.apiClient);
    setState(() {
      _future = future;
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Feed')),
      body: FutureBuilder<FeedResult>(
        future: _future,
        builder: (context, snapshot) {
          if (snapshot.connectionState != ConnectionState.done) {
            return const Center(child: CircularProgressIndicator());
          }
          if (snapshot.hasError) {
            return Center(
              child: Padding(
                padding: const EdgeInsets.all(24),
                child: Text('Could not load posts: ${snapshot.error}', style: AppType.body),
              ),
            );
          }
          final result = snapshot.data ?? const FeedResult([], null);
          final posts = result.posts;
          if (posts.isEmpty) {
            return ListView(
              physics: const AlwaysScrollableScrollPhysics(),
              children: [
                Padding(
                  padding: const EdgeInsets.all(24),
                  child: Text(result.notice ?? 'No posts yet.', style: AppType.body),
                ),
              ],
            );
          }
          return Column(
            children: [
              if (result.notice != null)
                Material(
                  color: Theme.of(context).colorScheme.secondaryContainer,
                  child: Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                    child: Text(result.notice!, style: AppType.label),
                  ),
                ),
              Expanded(
                child: RefreshIndicator(
                  onRefresh: () async => _reload(),
                  child: ListView.builder(
                    physics: const AlwaysScrollableScrollPhysics(),
                    itemCount: posts.length,
                    itemBuilder: (context, i) => _PostCard(post: posts[i]),
                  ),
                ),
              ),
            ],
          );
        },
      ),
    );
  }
}

class _PostCard extends StatelessWidget {
  const _PostCard({required this.post});

  final PostFeedEntry post;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(child: Text(post.sourceDisplayName, style: AppType.label)),
                Text(_when(post.postedAt ?? post.capturedAt), style: AppType.label),
              ],
            ),
            const SizedBox(height: 8),
            Text(post.rawText, style: AppType.body),
            const SizedBox(height: 8),
            Text(
              _statusLine,
              style: AppType.label,
            ),
          ],
        ),
      ),
    );
  }

  String get _statusLine {
    if (post.sourceKind == PostKind.context) {
      return post.sourceHandle == 'fixture-pulse'
          ? 'context from ESPN · not a tip'
          : 'news · not a tip';
    }
    return post.selectionCount > 0
        ? '${post.selectionCount} selection${post.selectionCount == 1 ? '' : 's'} parsed'
        : 'raw post · not parsed on-device';
  }

  static String _when(String? iso) {
    if (iso == null) return '';
    final parsed = DateTime.tryParse(iso)?.toLocal();
    if (parsed == null) return '';
    final now = DateTime.now();
    final diff = now.difference(parsed);
    if (diff.inMinutes < 1) return 'just now';
    if (diff.inHours < 1) return '${diff.inMinutes}m ago';
    if (diff.inDays < 1) return '${diff.inHours}h ago';
    return '${parsed.year}-${parsed.month.toString().padLeft(2, '0')}-${parsed.day.toString().padLeft(2, '0')}';
  }
}
