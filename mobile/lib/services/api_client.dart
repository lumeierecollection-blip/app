import 'dart:convert';

import 'package:http/http.dart' as http;

/// Talks to the plain Node.js backend (backend/server.js, Amendment E --
/// the Telegram + ESPN + push path; the odds-market endpoints this client
/// originally targeted were retired with the B stack). Paths and JSON field
/// names below match server.js's actual routes and camelCase response shape.
/// The base URL is injected at build time via
/// `--dart-define=API_BASE_URL=...` -- the Flutter/dart-define equivalent of
/// the original Expo-era `EXPO_PUBLIC_API_URL` convention, decided and
/// recorded in docs/ARCHITECTURE.md, wired through
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

class ApiClient {
  ApiClient({required this.baseUrl, http.Client? httpClient}) : _client = httpClient ?? http.Client();

  final String baseUrl;
  final http.Client _client;

  /// False when no cloud URL is configured (build-time or in-app). The app
  /// works standalone without it (FeedLoader's on-device scan); only these
  /// server-backed calls are unavailable.
  bool get configured => baseUrl.trim().isNotEmpty;

  Uri _uri(String path, [Map<String, String>? query]) {
    if (!configured) {
      throw ApiException(0, 'No cloud backend configured — set a URL on the Admin tab.');
    }
    return Uri.parse('$baseUrl$path').replace(queryParameters: query);
  }

  Map<String, dynamic> _decode(http.Response response) {
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw ApiException(response.statusCode, response.body);
    }
    return jsonDecode(response.body) as Map<String, dynamic>;
  }

  Future<bool> checkHealth() async {
    final response = await _client.get(_uri('/api/health'));
    return response.statusCode == 200;
  }

  Future<ServiceStatus> fetchStatus() async {
    final body = _decode(await _client.get(_uri('/api/status')));
    return ServiceStatus.fromJson(body);
  }

  Future<List<SourceChannel>> fetchSources() async {
    final body = _decode(await _client.get(_uri('/api/sources')));
    final raw = body['sources'] as List<dynamic>? ?? const [];
    return raw
        .map((e) => SourceChannel.fromJson(e as Map<String, dynamic>))
        .toList();
  }

  Future<List<PostFeedEntry>> fetchPosts({int limit = 50}) async {
    final body = _decode(await _client.get(_uri('/api/posts', {'limit': '$limit'})));
    final raw = body['posts'] as List<dynamic>? ?? const [];
    return raw
        .map((e) => PostFeedEntry.fromJson(e as Map<String, dynamic>))
        .toList();
  }

  Future<void> registerDevice({
    required String token,
    String? appInstallId,
    String platform = 'android',
  }) async {
    final response = await _client.post(
      _uri('/api/register-device'),
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({
        'token': token,
        if (appInstallId != null) 'appInstallId': appInstallId,
        'platform': platform,
      }),
    );
    if (response.statusCode != 200) {
      throw ApiException(response.statusCode, response.body);
    }
  }
}

/// One tracked Telegram source plus its latest all-window score from
/// /api/sources. `score` is null until the source has settled anything.
class SourceChannel {
  SourceChannel({
    required this.handle,
    required this.displayName,
    required this.active,
    required this.firstSeen,
    this.score,
  });

  final String handle;
  final String displayName;
  final bool active;
  final String? firstSeen;
  final ChannelScore? score;

  factory SourceChannel.fromJson(Map<String, dynamic> json) {
    final scoreJson = json['score'];
    return SourceChannel(
      handle: json['handle'] as String,
      displayName: json['displayName'] as String? ?? json['handle'] as String,
      active: json['active'] as bool? ?? true,
      firstSeen: json['firstSeen'] as String?,
      score: scoreJson == null ? null : ChannelScore.fromJson(scoreJson as Map<String, dynamic>),
    );
  }
}

/// The all-window row of source_scores as served by /api/sources.
class ChannelScore {
  ChannelScore({
    required this.nSettled,
    this.roi,
    this.roiCiLow,
    this.roiCiHigh,
    this.hitRate,
    this.avgOdds,
    this.meanClv,
    this.pctPositiveClv,
    this.longestLosingRun,
    required this.rated,
    required this.disqualified,
    this.disqualificationReasons = const [],
  });

  final int nSettled;
  final double? roi;
  final double? roiCiLow;
  final double? roiCiHigh;
  final double? hitRate;
  final double? avgOdds;
  final double? meanClv;
  final double? pctPositiveClv;
  final int? longestLosingRun;
  final bool rated;
  final bool disqualified;
  final List<String> disqualificationReasons;

  factory ChannelScore.fromJson(Map<String, dynamic> json) {
    return ChannelScore(
      nSettled: (json['nSettled'] as num?)?.toInt() ?? 0,
      roi: (json['roi'] as num?)?.toDouble(),
      roiCiLow: (json['roiCiLow'] as num?)?.toDouble(),
      roiCiHigh: (json['roiCiHigh'] as num?)?.toDouble(),
      hitRate: (json['hitRate'] as num?)?.toDouble(),
      avgOdds: (json['avgOdds'] as num?)?.toDouble(),
      meanClv: (json['meanClv'] as num?)?.toDouble(),
      pctPositiveClv: (json['pctPositiveClv'] as num?)?.toDouble(),
      longestLosingRun: (json['longestLosingRun'] as num?)?.toInt(),
      rated: json['rated'] as bool? ?? false,
      disqualified: json['disqualified'] as bool? ?? false,
      disqualificationReasons:
          (json['disqualificationReasons'] as List<dynamic>? ?? const []).cast<String>(),
    );
  }
}

/// What a feed row is, honestly labeled:
/// - [tip]: a human's pick from Telegram/Reddit -- what the app exists to
///   aggregate. On-device rows are raw until the cloud parses/scores them.
/// - [context]: news headlines or fixture data -- useful for judging tips,
///   never scored, never rendered as a prediction (the audit rule).
enum PostKind { tip, context }

/// One post from /api/posts -- the feed row the Slips tab renders.
class PostFeedEntry {
  PostFeedEntry({
    required this.id,
    required this.sourceHandle,
    required this.sourceDisplayName,
    required this.rawText,
    this.postedAt,
    this.capturedAt,
    required this.selectionCount,
    this.sourceKind = PostKind.tip,
  });

  final String id;
  final String sourceHandle;
  final String sourceDisplayName;
  final String rawText;
  final String? postedAt;
  final String? capturedAt;
  final int selectionCount;
  final PostKind sourceKind;

  factory PostFeedEntry.fromJson(Map<String, dynamic> json) {
    return PostFeedEntry(
      // Cloud rows carry numeric ids; on-device scan rows use string ids
      // ('tg-<channel>/<n>', 'reddit-<id>', 'rss-<hash>', 'pulse-<espnId>')
      // -- both are opaque here.
      id: json['id']?.toString() ?? '',
      sourceHandle: json['handle'] as String? ?? json['sourceHandle'] as String? ?? '',
      sourceDisplayName: json['source_display_name'] as String? ??
          json['sourceDisplayName'] as String? ??
          json['handle'] as String? ??
          '',
      rawText: json['raw_text'] as String? ?? json['rawText'] as String? ?? '',
      postedAt: json['posted_at'] as String?,
      capturedAt: json['captured_at'] as String?,
      selectionCount: (json['selection_count'] as num?)?.toInt() ?? 0,
    );
  }
}

/// /api/status -- boot + scan health, including the loud Telegram state.
class ServiceStatus {
  ServiceStatus({
    required this.service,
    required this.telegramConfigured,
    required this.telegramState,
    required this.firebaseConfigured,
    this.lastScanAt,
    this.lastScanError,
  });

  final String service;
  final bool telegramConfigured;
  final String? telegramState;
  final bool firebaseConfigured;
  final String? lastScanAt;
  final String? lastScanError;

  factory ServiceStatus.fromJson(Map<String, dynamic> json) {
    final telegram = json['telegram'] as Map<String, dynamic>? ?? const {};
    return ServiceStatus(
      service: json['service'] as String? ?? '',
      telegramConfigured: telegram['configured'] as bool? ?? false,
      telegramState: telegram['state'] as String?,
      firebaseConfigured: json['firebase']?['configured'] as bool? ?? false,
      lastScanAt: json['lastScanAt'] as String?,
      lastScanError: json['lastScanError'] as String?,
    );
  }
}
