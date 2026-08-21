import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import 'app_shell.dart';
import 'services/api_client.dart';
import 'services/feed.dart';
import 'services/push.dart';
import 'services/settings.dart';
import 'theme/theme.dart';

/// Optional default for the cloud backend URL. Amendment F follows
/// tradeapp's model: the app is standalone (Telegram via t.me/s + ESPN,
/// scanned on-device), and a cloud backend is an *addition* typed into the
/// Admin tab -- this value just pre-fills that field at build time via
/// `--dart-define=API_BASE_URL=...`. An unset value boots fine.
const _apiBaseUrl = String.fromEnvironment('API_BASE_URL', defaultValue: '');

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  final apiClient = ApiClient(baseUrl: _apiBaseUrl);
  final settings = AppSettings(defaultCloudUrl: _apiBaseUrl);
  settings.load();
  final feedLoader = FeedLoader();

  if (apiClient.configured) {
    unawaited(PushManager.init(apiClient: apiClient));
  }

  runApp(
    MultiProvider(
      providers: [
        ChangeNotifierProvider.value(value: settings),
        Provider.value(value: apiClient),
      ],
      child: TipsterAggregatorApp(apiClient: apiClient, feedLoader: feedLoader),
    ),
  );
}

class TipsterAggregatorApp extends StatelessWidget {
  const TipsterAggregatorApp({super.key, required this.apiClient, this.feedLoader});

  final ApiClient apiClient;

  /// Injectable for tests; null uses the real loader.
  final FeedLoader? feedLoader;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Tipster Aggregator',
      debugShowCheckedModeBanner: false,
      theme: buildAppTheme(),
      home: AppShell(apiClient: apiClient, feedLoader: feedLoader),
    );
  }
}
