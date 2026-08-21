import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';

import 'package:tipster_aggregator/app_shell.dart';
import 'package:tipster_aggregator/main.dart';
import 'package:tipster_aggregator/services/api_client.dart';
import 'package:tipster_aggregator/services/feed.dart';
import 'package:tipster_aggregator/services/fixture_pulse.dart';
import 'package:tipster_aggregator/services/settings.dart';
import 'package:tipster_aggregator/services/telegram_source.dart';

class _EmptyPulse extends FixturePulse {
  @override
  Future<List<PostFeedEntry>> fetch({List<String>? leagues}) async => [];
}

class _EmptyTelegram extends TelegramSource {
  @override
  Future<List<ScannedPost>> fetchChannels(List<String> channels) async => [];
}

void main() {
  // Amendment F: no API URL is required at build time anymore. The app
  // boots standalone (on-device t.me/s scan + ESPN) exactly like tradeapp.
  testWidgets('app boots to the tab shell with nothing configured', (tester) async {
    final apiClient = ApiClient(baseUrl: '');
    final loader = FeedLoader(fixturePulse: _EmptyPulse(), telegramSource: _EmptyTelegram());
    await tester.pumpWidget(
      MultiProvider(
        providers: [
          ChangeNotifierProvider(create: (_) => AppSettings()),
          Provider.value(value: apiClient),
        ],
        child: TipsterAggregatorApp(apiClient: apiClient, feedLoader: loader),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.byType(AppShell), findsOneWidget);
    // The label appears on both the AppBar and the nav destination.
    expect(find.text('Slips'), findsWidgets);
    expect(find.textContaining('No Telegram channels followed yet'), findsOneWidget);
    expect(find.textContaining('No API_BASE_URL was set'), findsNothing);
  });
}
