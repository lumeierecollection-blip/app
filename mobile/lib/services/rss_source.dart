import 'package:http/http.dart' as http;

import 'api_client.dart';

/// On-device RSS reader for football news context -- tradeapp ships an RSS
/// source too (via the `xml` package); this one is dependency-free and reads
/// the simple RSS 2.0 shape the major sports publishers emit. Rows are
/// clearly labeled context ("news · not a tip"): headlines help you judge
/// tips (injuries, lineups, motivation) but are never scored or rendered as
/// predictions.
class RssSource {
  RssSource({http.Client? httpClient, this.limitPerFeed = 10})
      : _client = httpClient ?? http.Client();

  final http.Client _client;
  final int limitPerFeed;

  /// Long-standing public football feeds shipped as defaults.
  static const defaultFeeds = <String, String>{
    'BBC Sport football': 'https://feeds.bbci.co.uk/sport/football/rss.xml',
    'Guardian football': 'https://www.theguardian.com/football/rss',
  };

  Future<List<PostFeedEntry>> fetchFeeds([Map<String, String>? feeds]) async {
    final rows = <PostFeedEntry>[];
    for (final entry in (feeds ?? defaultFeeds).entries) {
      try {
        final res =
            await _client.get(Uri.parse(entry.value)).timeout(const Duration(seconds: 25));
        if (res.statusCode != 200) continue;
        rows.addAll(parseFeed(entry.key, res.body));
      } catch (_) {
        // A bad or blocked feed must never break the scan.
      }
    }
    return rows;
  }

  /// Pure RSS-2.0 parse step, public so tests can run it without network.
  List<PostFeedEntry> parseFeed(String feedName, String body) {
    final rows = <PostFeedEntry>[];
    for (final m in RegExp(r'<item[^>]*>(.*?)</item>', dotAll: true).allMatches(body)) {
      if (rows.length >= limitPerFeed) break;
      final item = m.group(1)!;
      final title = _tag(item, 'title');
      if (title.isEmpty) continue;
      final description = _stripHtml(_tag(item, 'description'));
      final link = _tag(item, 'link');
      final guid = _tag(item, 'guid');
      final text = [
        title,
        if (description.isNotEmpty) description,
      ].join('\n');

      rows.add(PostFeedEntry(
        id: 'rss-${(guid.isNotEmpty ? guid : link.isNotEmpty ? link : title).hashCode & 0x7FFFFFFF}',
        sourceHandle: 'news',
        sourceDisplayName: feedName,
        rawText: text,
        postedAt: _date(_tag(item, 'pubDate'))?.toIso8601String(),
        selectionCount: 0,
        sourceKind: PostKind.context,
      ));
    }
    return rows;
  }

  String _tag(String item, String tag) {
    final m = RegExp('<$tag(?:\\s[^>]*)?>(.*?)</$tag>', dotAll: true).firstMatch(item);
    if (m == null) return '';
    return _stripCdata(m.group(1)!).trim();
  }

  String _stripCdata(String s) =>
      s.replaceFirst(RegExp(r'^\s*<!\[CDATA\['), '').replaceFirst(RegExp(r'\]\]>\s*$'), '');

  String _stripHtml(String html) => html
      .replaceAll(RegExp(r'<[^>]+>'), ' ')
      .replaceAll('&amp;', '&')
      .replaceAll('&lt;', '<')
      .replaceAll('&gt;', '>')
      .replaceAll('&quot;', '"')
      .replaceAll('&#39;', "'")
      .replaceAll(RegExp(r'\s+'), ' ')
      .trim();

  DateTime? _date(String raw) {
    if (raw.isEmpty) return null;
    try {
      // RFC 1123 ('Mon, 01 Jan 2026 12:00:00 GMT') via dart:io-free parse:
      // DateTime.tryParse handles it in recent SDKs; fall back to HttpDate
      // shape manually for safety.
      final parsed = DateTime.tryParse(raw);
      if (parsed != null) return parsed;
      const months = {
        'jan': 1, 'feb': 2, 'mar': 3, 'apr': 4, 'may': 5, 'jun': 6,
        'jul': 7, 'aug': 8, 'sep': 9, 'oct': 10, 'nov': 11, 'dec': 12,
      };
      final parts = raw.split(RegExp(r'[ ,]+')).where((p) => p.isNotEmpty).toList();
      if (parts.length >= 4) {
        final day = int.tryParse(parts[1]);
        final month = months[parts[2].toLowerCase()];
        final year = int.tryParse(parts[3]);
        if (day != null && month != null && year != null) {
          var hour = 0, minute = 0;
          if (parts.length >= 5 && parts[4].contains(':')) {
            final t = parts[4].split(':');
            hour = int.tryParse(t[0]) ?? 0;
            minute = int.tryParse(t.length > 1 ? t[1] : '') ?? 0;
          }
          return DateTime.utc(year, month, day, hour, minute);
        }
      }
      return null;
    } catch (_) {
      return null;
    }
  }
}
