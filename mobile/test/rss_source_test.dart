import 'package:flutter_test/flutter_test.dart';
import 'package:tipster_aggregator/services/api_client.dart';
import 'package:tipster_aggregator/services/rss_source.dart';

void main() {
  // Minimal RSS 2.0 shape as emitted by BBC/Guardian feeds: CDATA titles,
  // HTML-laden descriptions, RFC-1123 pubDates.
  const xml = '<?xml version="1.0"?><rss version="2.0"><channel>'
      '<title>Football</title>'
      '<item><title><![CDATA[Arsenal v Chelsea team news]]></title>'
      '<link>https://example.com/1</link>'
      '<guid isPermaLink="false">g1</guid>'
      '<description><![CDATA[<p>Saka &amp; James fit to start</p>]]></description>'
      '<pubDate>Fri, 21 Aug 2026 09:30:00 GMT</pubDate></item>'
      '<item><title>Saturday preview</title>'
      '<link>https://example.com/2</link>'
      '<description>What to watch this weekend</description>'
      '<pubDate>bogus-date</pubDate></item>'
      '</channel></rss>';

  test('parses titles, strips html/cdata, keeps rows labeled as context', () {
    final source = RssSource();
    final rows = source.parseFeed('BBC Sport football', xml);
    expect(rows.length, 2);

    expect(rows[0].id, startsWith('rss-'));
    expect(rows[0].sourceHandle, 'news');
    expect(rows[0].sourceDisplayName, 'BBC Sport football');
    expect(rows[0].sourceKind, PostKind.context);
    expect(rows[0].rawText, 'Arsenal v Chelsea team news\nSaka & James fit to start');
    expect(rows[0].postedAt, '2026-08-21T09:30:00.000Z');

    // A broken pubDate must not drop the row -- it just has no timestamp.
    expect(rows[1].postedAt, isNull);
    expect(rows[1].rawText, 'Saturday preview\nWhat to watch this weekend');
  });
}
