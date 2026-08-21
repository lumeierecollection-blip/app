import 'api_client.dart';
import 'fixture_pulse.dart';
import 'settings.dart';
import 'telegram_source.dart';

/// What the feed shows and why. `notice` is the honest one-line state for
/// non-obvious situations (cloud configured but unreachable, nothing
/// followed yet) -- mirroring tradeapp's "Cloud feed offline — using
/// on-device scan." behavior. An empty list with a null notice is a real,
/// quiet empty.
class FeedResult {
  const FeedResult(this.posts, this.notice);

  final List<PostFeedEntry> posts;
  final String? notice;
}

/// Feed loading with tradeapp's exact fallback shape (app_state.dart's
/// refresh()): if a cloud backend URL is configured, try it first; on any
/// failure fall back to the on-device scan rather than showing an error
/// wall. Without a cloud URL the app is fully standalone: Telegram via the
/// public t.me/s preview + ESPN fixtures, straight from the phone.
class FeedLoader {
  FeedLoader({FixturePulse? fixturePulse, TelegramSource? telegramSource})
      : _fixturePulse = fixturePulse ?? FixturePulse(),
        _telegram = telegramSource ?? TelegramSource();

  final FixturePulse _fixturePulse;
  final TelegramSource _telegram;

  Future<FeedResult> load(AppSettings settings, ApiClient apiClient) async {
    if (settings.cloudConfigured) {
      try {
        final posts = await apiClient.fetchPosts();
        return FeedResult(posts, null);
      } catch (_) {
        final local = await scanLocal(settings.telegramChannels);
        return FeedResult(local, 'Cloud feed offline — showing on-device scan.');
      }
    }

    final channels = settings.telegramChannels;
    final local = await scanLocal(channels);
    if (channels.isEmpty) {
      return FeedResult(
        local,
        'No Telegram channels followed yet — add usernames on the Admin tab '
        '(open t.me/s/<name> in a browser first; if you can see posts there, this app '
        'can read them). Fixtures below come from ESPN.',
      );
    }
    return FeedResult(local, null);
  }

  Future<List<PostFeedEntry>> scanLocal(List<String> channels) async {
    final results = await Future.wait([
      _telegram.fetchChannels(channels),
      _fixturePulse.fetch(),
    ]);
    final posts = <PostFeedEntry>[];
    posts.addAll(results[0].map(_toFeedEntry));
    posts.addAll(results[1]);
    posts.sort((a, b) => (b.postedAt ?? '').compareTo(a.postedAt ?? ''));
    return posts;
  }

  PostFeedEntry _toFeedEntry(ScannedPost p) => PostFeedEntry(
        id: p.id,
        sourceHandle: p.channel,
        sourceDisplayName: '@${p.channel}',
        rawText: p.text,
        postedAt: p.postedAt?.toIso8601String(),
        capturedAt: p.postedAt?.toIso8601String(),
        selectionCount: 0,
      );
}
