import 'dart:convert';

import 'package:http/http.dart' as http;

import 'api_client.dart';

/// On-device Reddit scanner -- tradeapp's `reddit_source.dart` pattern
/// applied to football betting: the public JSON endpoints need no login,
/// just an honest User-Agent (Reddit rate-limits default UA strings).
/// Failing subs are skipped silently, never fabricated.
class RedditSource {
  RedditSource({http.Client? httpClient, this.limitPerSub = 15})
      : _client = httpClient ?? http.Client();

  final http.Client _client;
  final int limitPerSub;

  /// Subreddits shipped as defaults. These are large, long-standing public
  /// communities; users can override the list on the Admin tab.
  static const defaultSubs = ['SoccerBetting', 'sportsbook'];

  Future<List<PostFeedEntry>> fetchSubs(List<String> subs) async {
    final rows = <PostFeedEntry>[];
    for (final sub in subs) {
      try {
        final res = await _client
            .get(
              Uri.parse('https://www.reddit.com/r/$sub/new.json?limit=$limitPerSub'),
              headers: {
                'User-Agent': 'tipster-aggregator-android/1.0 (public preview reader)',
              },
            )
            .timeout(const Duration(seconds: 25));
        if (res.statusCode != 200) continue;
        final body = jsonDecode(res.body) as Map<String, dynamic>;
        final children =
            (body['data'] as Map<String, dynamic>? ?? const {})['children'] as List<dynamic>? ?? const [];
        for (final child in children) {
          if (child is! Map<String, dynamic>) continue;
          final post = child['data'] as Map<String, dynamic>? ?? const {};
          final title = post['title']?.toString() ?? '';
          if (title.isEmpty) continue;
          final selftext = post['selftext']?.toString() ?? '';
          // Link-only posts carry no readable tip text; keep title-only
          // rows out unless there's something to read.
          final text = [title, if (selftext.isNotEmpty && selftext != '[removed]' && selftext != '[deleted]') selftext]
              .join('\n')
              .trim();
          final created = (post['created_utc'] as num?)?.toInt();
          rows.add(PostFeedEntry(
            id: 'reddit-${post['id'] ?? title.hashCode}',
            sourceHandle: 'r/${sub.toLowerCase()}',
            sourceDisplayName: 'r/$sub',
            rawText: text,
            postedAt: created == null || created == 0
                ? null
                : DateTime.fromMillisecondsSinceEpoch(created * 1000).toIso8601String(),
            selectionCount: 0,
            sourceKind: PostKind.tip,
          ));
        }
      } catch (_) {
        // Sub may be private, quarantined, or rate-limited -- skip it.
      }
    }
    return rows;
  }
}
