import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import 'app_shell.dart';
import 'services/api_client.dart';
import 'services/push.dart';
import 'services/settings.dart';
import 'theme/theme.dart';

/// Injected at build time via `--dart-define=API_BASE_URL=...`
/// (see lib/services/api_client.dart's docstring). No default pointing
/// at a real production host is baked in here -- an unset value fails
/// loud in the API client rather than silently talking to the wrong
/// place.
const _apiBaseUrl = String.fromEnvironment('API_BASE_URL', defaultValue: '');

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  final apiClient = ApiClient(baseUrl: _apiBaseUrl);
  final settings = AppSettings();
  settings.load();

  unawaited(PushManager.init(apiClient: apiClient));

  runApp(
    MultiProvider(
      providers: [
        ChangeNotifierProvider.value(value: settings),
        Provider.value(value: apiClient),
      ],
      child: TipsterAggregatorApp(apiClient: apiClient),
    ),
  );
}

class TipsterAggregatorApp extends StatelessWidget {
  const TipsterAggregatorApp({super.key, required this.apiClient});

  final ApiClient apiClient;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Tipster Aggregator',
      debugShowCheckedModeBanner: false,
      theme: buildAppTheme(),
      home: _apiBaseUrl.isEmpty
          ? const _MissingApiUrlScreen()
          : AppShell(apiClient: apiClient),
    );
  }
}

/// A real error state, not synthetic data: Amendment B7 removed demo
/// mode entirely, so a build with no API URL injected fails loud here
/// instead of falling back to fake fixtures.
class _MissingApiUrlScreen extends StatelessWidget {
  const _MissingApiUrlScreen();

  @override
  Widget build(BuildContext context) {
    return const Scaffold(
      body: Center(
        child: Padding(
          padding: EdgeInsets.all(24),
          child: Text(
            'No API_BASE_URL was set at build time.\n\n'
            'Build with --dart-define=API_BASE_URL=https://your-backend-host',
            textAlign: TextAlign.center,
          ),
        ),
      ),
    );
  }
}
