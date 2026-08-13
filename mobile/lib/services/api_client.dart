import 'dart:convert';

import 'package:http/http.dart' as http;

/// Talks to the plain Node.js backend (backend/server.js, Prompt 8 --
/// replaced the earlier FastAPI backend this client originally targeted;
/// paths and JSON field names below match server.js's actual routes and
/// camelCase response shape, not snake_case). The base URL is injected at
/// build time via `--dart-define=API_BASE_URL=...` -- the Flutter/dart-define
/// equivalent of the original Expo-era `EXPO_PUBLIC_API_URL` convention,
/// decided and recorded in docs/ARCHITECTURE.md, wired through
/// .github/workflows/build-apk.yml.
///
/// Demo mode is removed per Amendment B7 -- there is no fallback data. A
/// failed call is a real error shown to the user, not synthetic data
/// standing in for it.
class ApiException implements Exception {
  ApiException(this.statusCode, this.message);
  final int statusCode;
  final String message;

  @override
  String toString() => 'ApiException($statusCode): $message';
}

class FairPrice {
  FairPrice({required this.fixtureId, required this.market, required this.fairPrices});

  final String fixtureId;
  final String market;
  final Map<String, double> fairPrices;

  factory FairPrice.fromJson(Map<String, dynamic> json) {
    final rawPrices = json['fairPrices'] as Map<String, dynamic>;
    return FairPrice(
      fixtureId: json['fixtureId'] as String,
      market: json['market'] as String,
      fairPrices: rawPrices.map((k, v) => MapEntry(k, (v as num).toDouble())),
    );
  }
}

class ManualCheckResult {
  ManualCheckResult({
    required this.id,
    required this.fairProbability,
    required this.fairOdds,
    required this.edge,
    required this.stakeFraction,
    required this.passedGates,
    required this.rejections,
  });

  final String id;
  final double fairProbability;
  final double fairOdds;
  final double edge;
  final double? stakeFraction;
  final bool passedGates;
  final List<String> rejections;

  factory ManualCheckResult.fromJson(Map<String, dynamic> json) {
    return ManualCheckResult(
      id: json['id'] as String,
      fairProbability: (json['fairProbability'] as num).toDouble(),
      fairOdds: (json['fairOdds'] as num).toDouble(),
      edge: (json['edge'] as num).toDouble(),
      stakeFraction: (json['stakeFraction'] as num?)?.toDouble(),
      passedGates: json['passedGates'] as bool,
      rejections: (json['rejections'] as List).cast<String>(),
    );
  }
}

class ApiClient {
  ApiClient({required this.baseUrl, http.Client? httpClient}) : _client = httpClient ?? http.Client();

  final String baseUrl;
  final http.Client _client;

  Uri _uri(String path, [Map<String, String>? query]) => Uri.parse('$baseUrl$path').replace(queryParameters: query);

  Future<bool> checkHealth() async {
    final response = await _client.get(_uri('/api/health'));
    return response.statusCode == 200;
  }

  Future<FairPrice> fetchFairPrice({required String fixtureId, required String market}) async {
    final response = await _client.get(
      _uri('/api/manual-check/fair-price', {'fixture': fixtureId, 'market': market}),
    );
    if (response.statusCode != 200) {
      throw ApiException(response.statusCode, response.body);
    }
    return FairPrice.fromJson(jsonDecode(response.body) as Map<String, dynamic>);
  }

  Future<ManualCheckResult> submitManualCheck({
    required String fixtureId,
    required String market,
    required String pick,
    required double enteredOdds,
    required String enteredBookmaker,
    double? line,
  }) async {
    final response = await _client.post(
      _uri('/api/manual-check'),
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({
        'fixture': fixtureId,
        'market': market,
        'pick': pick,
        'offeredOdds': enteredOdds,
        'bookmaker': enteredBookmaker,
        if (line != null) 'line': line,
      }),
    );
    if (response.statusCode != 200) {
      throw ApiException(response.statusCode, response.body);
    }
    return ManualCheckResult.fromJson(jsonDecode(response.body) as Map<String, dynamic>);
  }
}
