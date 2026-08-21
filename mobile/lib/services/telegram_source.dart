import 'package:http/http.dart' as http;

/// On-device Telegram scanner -- the same technique tradeapp's app uses
/// (`signal_aggregator/lib/services/sources/telegram_source.dart`) and this
/// project's backend uses (backend/lib/sources.js): fetch the public
/// `t.me/s/<channel>` preview page and parse it. No credentials, no backend
/// required -- the phone fetches exactly what a browser would see.
///
/// Private/invite-only channels simply aren't readable this way; a failing
/// channel is skipped silently (tradeapp's behavior too), never fabricated.
class ScannedPost {
  const ScannedPost({
    required this.id,
    required this.channel,
    required this.text,
    this.postedAt,
    required this.url,
  });

  final String id; // 'tg-<channel>/<messageNumber>'
  final String channel;
  final String text;
  final DateTime? postedAt;
  final String url;
}

class TelegramSource {
  TelegramSource({http.Client? httpClient}) : _client = httpClient ?? http.Client();

  final http.Client _client;

  Future<List<ScannedPost>> fetchChannels(List<String> channels) async {
    final posts = <ScannedPost>[];
    for (final channel in channels) {
      try {
        final res = await _client
            .get(Uri.parse('https://t.me/s/$channel'))
            .timeout(const Duration(seconds: 25));
        if (res.statusCode != 200) continue;
        posts.addAll(parseChannel(channel, res.body));
      } catch (_) {
        // Channel may be private or the preview unavailable -- skip it.
      }
    }
    return posts;
  }

  /// Slices the page per message (so a media-only message between two text
  /// messages can't bleed markup across), then extracts the timestamp and
  /// text from each slice. Same structure as the backend parser.
  List<ScannedPost> parseChannel(String channel, String html) {
    final marker = RegExp(r'<div class="tgme_widget_message[^"]*"[^>]*data-post="([^"]+)"');
    final matches = marker.allMatches(html).toList();
    final posts = <ScannedPost>[];
    for (var i = 0; i < matches.length; i++) {
      final postId = matches[i].group(1)!;
      final end = i + 1 < matches.length ? matches[i + 1].start : html.length;
      final slice = html.substring(matches[i].start, end);

      final timeMatch = RegExp(r'<time datetime="([^"]+)"').firstMatch(slice);
      final textMatch =
          RegExp(r'<div class="tgme_widget_message_text[^"]*"[^>]*>(.*?)</div>', dotAll: true)
              .firstMatch(slice);
      final rawText = textMatch == null ? '' : _cleanHtml(textMatch.group(1) ?? '');
      if (rawText.isEmpty) continue; // media-only message

      posts.add(ScannedPost(
        id: 'tg-$postId',
        channel: channel,
        text: rawText,
        postedAt: timeMatch == null ? null : DateTime.tryParse(timeMatch.group(1)!),
        url: 'https://t.me/$postId',
      ));
    }
    return posts;
  }

  String _cleanHtml(String html) {
    final withBreaks = html
        .replaceAll(RegExp(r'<br\s*/?>'), '\n')
        .replaceAll(RegExp(r'<[^>]+>'), ' ')
        .replaceAll('&amp;', '&')
        .replaceAll('&lt;', '<')
        .replaceAll('&gt;', '>')
        .replaceAll('&quot;', '"')
        .replaceAll('&#39;', "'");
    // Collapse runs of spaces/tabs within each line, but keep the line
    // breaks a <br/> represents -- a bare `\s+` collapse (the previous
    // approach) eats newlines along with spaces and glues joined lines
    // like a "join @channel" signature onto the tip text above it.
    return withBreaks
        .split('\n')
        .map((line) => line.replaceAll(RegExp(r'[ \t]+'), ' ').trim())
        .where((line) => line.isNotEmpty)
        .join('\n')
        .trim();
  }
}
