import 'package:flutter_test/flutter_test.dart';
import 'package:tipster_aggregator/services/telegram_source.dart';

void main() {
  // Same markup shape as the backend parser's fixture
  // (fixtures/telegram_preview/sample.json) -- double-quoted attributes,
  // a media-only message that must be skipped, and entity/br cleanup.
  const html = '<div class="tgme_widget_message_wrap">'
      '<div class="tgme_widget_message js-widget_message" data-post="tipsterdemo/101">'
      '<time datetime="2026-08-20T17:30:00+00:00">17:30</time>'
      '<div class="tgme_widget_message_text js-message_text" dir="auto">'
      'Arsenal to beat Chelsea @ 1.85, over 2.5 goals too</div></div></div>'
      '<div class="tgme_widget_message_wrap">'
      '<div class="tgme_widget_message js-widget_message" data-post="tipsterdemo/102">'
      '<time datetime="2026-08-20T18:05:00+00:00">18:05</time>'
      '<div class="tgme_widget_message_photo_wrap"></div></div></div>'
      '<div class="tgme_widget_message_wrap">'
      '<div class="tgme_widget_message js-widget_message" data-post="tipsterdemo/103">'
      '<time datetime="2026-08-21T09:12:00+00:00">09:12</time>'
      '<div class="tgme_widget_message_text js-message_text" dir="auto">'
      '<b>Man Utd</b> win &amp; BTTS yes @ 2.10<br/>join @vipchannel</div></div></div>';

  test('parses ids, timestamps, and cleaned text; skips media-only messages', () {
    final source = TelegramSource();
    final posts = source.parseChannel('tipsterdemo', html);

    expect(posts.length, 2);
    expect(posts[0].id, 'tg-tipsterdemo/101');
    expect(posts[0].channel, 'tipsterdemo');
    expect(posts[0].postedAt, DateTime.utc(2026, 8, 20, 17, 30));
    expect(posts[0].text, 'Arsenal to beat Chelsea @ 1.85, over 2.5 goals too');
    expect(posts[0].url, 'https://t.me/tipsterdemo/101');

    expect(posts[1].text, 'Man Utd win & BTTS yes @ 2.10\njoin @vipchannel');
    expect(posts[1].postedAt, DateTime.utc(2026, 8, 21, 9, 12));
  });

  test('a media-only message between text messages does not bleed markup', () {
    final source = TelegramSource();
    final posts = source.parseChannel('c', html);
    expect(posts.every((p) => !p.text.contains('data-post')), isTrue);
    expect(posts.every((p) => !p.text.contains('photo')), isTrue);
  });
}
