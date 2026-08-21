import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:tipster_aggregator/services/api_client.dart';
import 'package:tipster_aggregator/services/feed.dart';
import 'package:tipster_aggregator/services/fixture_pulse.dart';
import 'package:tipster_aggregator/services/reddit_source.dart';
import 'package:tipster_aggregator/services/rss_source.dart';
import 'package:tipster_aggregator/services/settings.dart';
import 'package:tipster_aggregator/services/telegram_source.dart';

class _PulseStub extends FixturePulse {
  _PulseStub(this.rows);
  final List<PostFeedEntry> rows;
  @override
  Future<List<PostFeedEntry>> fetch({List<String>? leagues}) async => rows;
}

class _TelegramStub extends TelegramSource {
  _TelegramStub(this.posts);
  final List<ScannedPost> posts;
  @override
  Future<List<ScannedPost>> fetchChannels(List<String> channels) async => posts;
}

class _RedditStub extends RedditSource {
  _RedditStub(this.rows);
  final List<PostFeedEntry> rows;
  @override
  Future<List<PostFeedEntry>> fetchSubs(List<String> subs) async => rows;
}

class _RssStub extends RssSource {
  _RssStub(this.rows);
  final List<PostFeedEntry> rows;
  @override
  Future<List<PostFeedEntry>> fetchFeeds([Map<String, String>? feeds]) async => rows;
}

class _ApiStub extends ApiClient {
  _ApiStub(String baseUrl, {this.fail = false}) : super(baseUrl: baseUrl);
  final bool fail;
  @override
  Future<List<PostFeedEntry>> fetchPosts({int limit = 50}) async {
    if (fail) throw ApiException(0, 'offline');
    return [
      PostFeedEntry(
        id: '42',
        sourceHandle: 'cloudchannel',
        sourceDisplayName: '@cloudchannel',
        rawText: 'server-parsed post',
        selectionCount: 2,
      ),
    ];
  }
}

PostFeedEntry tipRow(String id, String handle, {String? date}) => PostFeedEntry(
      id: id,
      sourceHandle: handle,
      sourceDisplayName: handle.startsWith('r/') ? handle : '@$handle',
      rawText: 'pick text',
      postedAt: date,
      selectionCount: 0,
      sourceKind: PostKind.tip,
    );

PostFeedEntry contextRow(String id, String handle, String date) => PostFeedEntry(
      id: id,
      sourceHandle: handle,
      sourceDisplayName: handle,
      rawText: 'context text',
      postedAt: date,
      selectionCount: 0,
      sourceKind: PostKind.context,
    );

void main() {
  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  test('fresh install (no channels): reddit defaults still produce tips', () async {
    final loader = FeedLoader(
      fixturePulse: _PulseStub([contextRow('pulse-1', 'fixture-pulse', '2026-08-22T16:30:00Z')]),
      telegramSource: _TelegramStub([]),
      redditSource: _RedditStub([tipRow('reddit-a', 'r/soccerbetting')]),
      rssSource: _RssStub([contextRow('rss-1', 'news', '2026-08-21T09:00:00Z')]),
    );
    final result = await loader.load(AppSettings(), _ApiStub(''));

    // Tips lead even though the fixtures are "newer" by postedAt.
    expect(result.posts.first.id, 'reddit-a');
    expect(result.notice, isNull, reason: 'defaults are on, so a quiet scan is normal');
    // Context appended after tips.
    final ids = result.posts.map((p) => p.id).toList();
    expect(ids.indexOf('reddit-a'), lessThan(ids.indexOf('rss-1')));
  });

  test('all sources off: honest notice, no silent empty', () async {
    final loader = FeedLoader(
      fixturePulse: _PulseStub([]),
      telegramSource: _TelegramStub([]),
      redditSource: _RedditStub([]),
      rssSource: _RssStub([]),
    );
    final settings = AppSettings()..setSourceEnabled(reddit: false, rss: false, espn: false);
    final result = await loader.load(settings, _ApiStub(''));
    expect(result.posts, isEmpty);
    expect(result.notice, contains('No tip sources on'));
  });

  test('sources on but nothing found: pull-to-refresh notice', () async {
    final loader = FeedLoader(
      fixturePulse: _PulseStub([]),
      telegramSource: _TelegramStub([]),
      redditSource: _RedditStub([]),
      rssSource: _RssStub([contextRow('rss-1', 'news', '2026-08-21T09:00:00Z')]),
    );
    final settings = AppSettings()..setTelegramChannels(['chan']);
    final result = await loader.load(settings, _ApiStub(''));
    expect(result.posts.single.id, 'rss-1');
    expect(result.notice, contains('No tips found'));
  });

  test('telegram + reddit tips interleave newest-first ahead of context', () async {
    final loader = FeedLoader(
      fixturePulse: _PulseStub([]),
      telegramSource: _TelegramStub([
        ScannedPost(
          id: 'tg-c/3',
          channel: 'c',
          text: 'old tip',
          postedAt: DateTime.utc(2026, 8, 20, 10),
          url: 'x',
        ),
        ScannedPost(
          id: 'tg-c/4',
          channel: 'c',
          text: 'new tip',
          postedAt: DateTime.utc(2026, 8, 21, 18),
          url: 'x',
        ),
      ]),
      redditSource: _RedditStub([tipRow('reddit-b', 'r/soccerbetting', date: '2026-08-21T12:00:00Z')]),
      rssSource: _RssStub([]),
    );
    final settings = AppSettings()..setTelegramChannels(['c']);
    final result = await loader.load(settings, _ApiStub(''));
    expect(result.posts.map((p) => p.id).toList(),
        ['tg-c/4', 'reddit-b', 'tg-c/3']);
  });

  test('cloud configured and healthy wins', () async {
    final loader = FeedLoader(
      fixturePulse: _PulseStub([]),
      telegramSource: _TelegramStub([]),
      redditSource: _RedditStub([]),
      rssSource: _RssStub([]),
    );
    final settings = AppSettings()..setCloudUrl('https://example.com');
    final result = await loader.load(settings, _ApiStub('https://example.com'));
    expect(result.posts.single.id, '42');
    expect(result.notice, isNull);
  });

  test('cloud configured but down falls back to on-device scan, loudly', () async {
    final loader = FeedLoader(
      fixturePulse: _PulseStub([]),
      telegramSource: _TelegramStub([]),
      redditSource: _RedditStub([tipRow('reddit-a', 'r/soccerbetting')]),
      rssSource: _RssStub([]),
    );
    final settings = AppSettings()..setCloudUrl('https://example.com');
    final result = await loader.load(settings, _ApiStub('https://example.com', fail: true));
    expect(result.posts.single.id, 'reddit-a');
    expect(result.notice, contains('Cloud feed offline'));
  });
}
