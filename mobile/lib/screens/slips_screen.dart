import 'package:flutter/material.dart';

import '../services/api_client.dart';
import '../theme/type.dart';

/// docs/DESIGN.md §11.8 screen 1, the home screen. Amendment E repoints it
/// at the backend's /api/posts -- the recent Telegram posts the backend
/// ingested and parsed, newest first. A post's `selection_count` is how many
/// picks were extracted from it; the raw text is shown so nothing is hidden
/// behind a fabricated slip shape. An empty list is the real state of a
/// server that has ingested nothing yet (Amendment B7 removed demo mode).
class SlipsScreen extends StatefulWidget {
  const SlipsScreen({super.key, required this.apiClient});

  final ApiClient apiClient;

  @override
  State<SlipsScreen> createState() => _SlipsScreenState();
}

class _SlipsScreenState extends State<SlipsScreen> {
  late Future<List<PostFeedEntry>> _future;

  @override
  void initState() {
    super.initState();
    _future = widget.apiClient.fetchPosts();
  }

  Future<void> _reload() async {
    setState(() => _future = widget.apiClient.fetchPosts());
    await _future;
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Slips')),
      body: FutureBuilder<List<PostFeedEntry>>(
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
          final posts = snapshot.data ?? const [];
          if (posts.isEmpty) {
            return const Center(
              child: Padding(
                padding: EdgeInsets.all(24),
                child: Text(
                  'No posts yet.\n\nThe backend follows the Telegram channels listed on the '
                  'Tipsters tab and parses each post into selections. Check the Health tab for '
                  'ingestion status.',
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
              itemCount: posts.length,
              itemBuilder: (context, i) => _PostCard(post: posts[i]),
            ),
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
                Expanded(
                  child: Text(post.sourceDisplayName, style: AppType.label),
                ),
                Text(
                  _when(post.postedAt ?? post.capturedAt),
                  style: AppType.label,
                ),
              ],
            ),
            const SizedBox(height: 8),
            Text(post.rawText, style: AppType.body),
            const SizedBox(height: 8),
            Text(
              post.selectionCount == 1
                  ? '1 selection parsed'
                  : '${post.selectionCount} selections parsed',
              style: AppType.label,
            ),
          ],
        ),
      ),
    );
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
