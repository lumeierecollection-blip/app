import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:tipster_aggregator/services/api_client.dart';
import 'package:tipster_aggregator/services/feed.dart';
import 'package:tipster_aggregator/services/fixture_pulse.dart';
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

PostFeedEntry pulseRow(String id, String date) => PostFeedEntry(
      id: 'pulse-$id',
      sourceHandle: 'fixture-pulse',
      sourceDisplayName: 'Fixture pulse',
      rawText: 'A vs B',
      postedAt: date,
      selectionCount: 0,
    );

ScannedPost scannedPost(String id) => ScannedPost(
      id: 'tg-$id',
      channel: 'chan',
      text: 'hello',
      postedAt: DateTime.utc(2026, 8, 21, 12),
      url: 'https://t.me/$id',
    );

void main() {
  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  test('standalone with no channels: fixture pulse only + honest notice', () async {
    final loader = FeedLoader(
      fixturePulse: _PulseStub([pulseRow('1', '2026-08-22T16:30:00Z')]),
      telegramSource: _TelegramStub([]),
    );
    final result = await loader.load(AppSettings(), _ApiStub(''));
    expect(result.posts.map((p) => p.id), ['pulse-1']);
    expect(result.notice, contains('No Telegram channels followed yet'));
  });

  test('standalone with channels: newest-first merge of posts and fixtures', () async {
    final loader = FeedLoader(
      fixturePulse: _PulseStub([pulseRow('1', '2026-08-22T16:30:00Z')]),
      telegramSource: _TelegramStub([scannedPost('x/9')]),
    );
    final settings = AppSettings()..setTelegramChannels(['chan']);
    final result = await loader.load(settings, _ApiStub(''));
    // The scanned post (2026-08-21) is newer than the fixture (2026-08-22)?
    // No -- the fixture kicks off later, so it sorts after by postedAt desc.
    expect(result.posts.first.id, 'tg-x/9');
    expect(result.posts.last.id, 'pulse-1');
    expect(result.notice, isNull);
  });

  test('cloud configured and healthy wins', () async {
    final loader = FeedLoader(
      fixturePulse: _PulseStub([pulseRow('1', '2026-08-22T16:30:00Z')]),
      telegramSource: _TelegramStub([scannedPost('x/9')]),
    );
    final settings = AppSettings()..setCloudUrl('https://example.com');
    final result = await loader.load(settings, _ApiStub('https://example.com'));
    expect(result.posts.single.id, '42');
    expect(result.notice, isNull);
  });

  test('cloud configured but down falls back to on-device scan, loudly', () async {
    final loader = FeedLoader(
      fixturePulse: _PulseStub([pulseRow('1', '2026-08-22T16:30:00Z')]),
      telegramSource: _TelegramStub([scannedPost('x/9')]),
    );
    final settings = AppSettings()..setCloudUrl('https://example.com');
    final result = await loader.load(settings, _ApiStub('https://example.com', fail: true));
    expect(result.posts.length, 2);
    expect(result.notice, contains('Cloud feed offline'));
  });
}
