import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';

import 'package:tipster_aggregator/main.dart';
import 'package:tipster_aggregator/services/api_client.dart';
import 'package:tipster_aggregator/services/settings.dart';

void main() {
  testWidgets('app boots and shows the missing-API-URL state when none is injected', (tester) async {
    final apiClient = ApiClient(baseUrl: '');
    await tester.pumpWidget(
      MultiProvider(
        providers: [
          ChangeNotifierProvider(create: (_) => AppSettings()),
          Provider.value(value: apiClient),
        ],
        child: TipsterAggregatorApp(apiClient: apiClient),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.textContaining('No API_BASE_URL was set'), findsOneWidget);
  });
}
