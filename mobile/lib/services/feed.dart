import 'api_client.dart';
import 'fixture_pulse.dart';
import 'reddit_source.dart';
import 'rss_source.dart';
import 'settings.dart';
import 'telegram_source.dart';

/// What the feed shows and why. `notice` is the honest one-line state for
/// non-obvious situations -- mirroring tradeapp's "Cloud feed offline —
/// using on-device scan." behavior. An empty list with a null notice is a
/// real, quiet empty.
class FeedResult {
  const FeedResult(this.posts, this.notice);

  final List<PostFeedEntry> posts;
  final String? notice;
}

/// The feed accumulator, tradeapp's SourceRegistry shape: fetch every
/// enabled source, dedupe by id, then order it tips-first --
/// [Telegram + Reddit] newest first, [news RSS + ESPN fixtures] below as
/// clearly-labeled context. With a cloud URL configured the server's
/// already-parsed feed wins; any failure falls back to this on-device scan,
/// loudly labeled ("Cloud feed offline — showing on-device scan.").
class FeedLoader {
  FeedLoader({
    FixturePulse? fixturePulse,
    TelegramSource? telegramSource,
    RedditSource? redditSource,
    RssSource? rssSource,
  })  : _fixturePulse = fixturePulse ?? FixturePulse(),
        _telegram = telegramSource ?? TelegramSource(),
        _reddit = redditSource ?? RedditSource(),
        _rss = rssSource ?? RssSource();

  final FixturePulse _fixturePulse;
  final TelegramSource _telegram;
  final RedditSource _reddit;
  final RssSource _rss;

  Future<FeedResult> load(AppSettings settings, ApiClient apiClient) async {
    if (settings.cloudConfigured) {
      try {
        final posts = await apiClient.fetchPosts();
        return FeedResult(posts, null);
      } catch (_) {
        final local = await scanLocal(settings);
        return FeedResult(local.posts, 'Cloud feed offline — showing on-device scan.');
      }
    }

    final local = await scanLocal(settings);
    final followsAnyTips =
        (settings.telegramEnabled && settings.telegramChannels.isNotEmpty) ||
            (settings.redditEnabled && settings.redditSubs.isNotEmpty);
    if (!followsAnyTips) {
      return FeedResult(
        local.posts,
        'No tip sources on — enable Reddit/Telegram and add usernames on the '
        'Admin tab. Context rows below are news and fixtures only.',
      );
    }
    if (local.tips.isEmpty) {
      return FeedResult(
        local.posts,
        'No tips found in this scan — context (news/fixtures) is shown below. '
        'Pull to refresh.',
      );
    }
    return FeedResult(local.posts, null);
  }

  Future<ScanOutcome> scanLocal(AppSettings settings) async {
    final tipsFutures = <Future<List<PostFeedEntry>>>[];
    if (settings.telegramEnabled && settings.telegramChannels.isNotEmpty) {
      tipsFutures.add(_telegram.fetchChannels(settings.telegramChannels).then(_asTipRows));
    }
    if (settings.redditEnabled && settings.redditSubs.isNotEmpty) {
      tipsFutures.add(_reddit.fetchSubs(settings.redditSubs));
    }

    final contextFutures = <Future<List<PostFeedEntry>>>[];
    if (settings.rssEnabled) contextFutures.add(_rss.fetchFeeds());
    if (settings.espnEnabled) contextFutures.add(_fixturePulse.fetch());

    final tipBatches = await Future.wait(tipsFutures);
    final contextBatches = await Future.wait(contextFutures);

    // Registry-style global dedupe by id across all sources.
    final seen = <String>{};
    final tips = <PostFeedEntry>[];
    for (final batch in tipBatches) {
      for (final row in batch) {
        if (seen.add(row.id)) tips.add(row);
      }
    }
    final context = <PostFeedEntry>[];
    for (final batch in contextBatches) {
      for (final row in batch) {
        if (seen.add(row.id)) context.add(row);
      }
    }

    int byNewest(PostFeedEntry a, PostFeedEntry b) =>
        (b.postedAt ?? '').compareTo(a.postedAt ?? '');
    tips.sort(byNewest);
    context.sort(byNewest);

    return ScanOutcome(posts: [...tips, ...context], tips: tips);
  }

  List<PostFeedEntry> _asTipRows(List<ScannedPost> scanned) =>
      scanned.map((p) => PostFeedEntry(
            id: p.id,
            sourceHandle: p.channel,
            sourceDisplayName: '@${p.channel}',
            rawText: p.text,
            postedAt: p.postedAt?.toIso8601String(),
            capturedAt: p.postedAt?.toIso8601String(),
            selectionCount: 0,
            sourceKind: PostKind.tip,
          )).toList();
}

class ScanOutcome {
  const ScanOutcome({required this.posts, required this.tips});

  /// Everything to render: tips first, context appended below.
  final List<PostFeedEntry> posts;

  /// Just the tip rows (Telegram + Reddit).
  final List<PostFeedEntry> tips;
}
