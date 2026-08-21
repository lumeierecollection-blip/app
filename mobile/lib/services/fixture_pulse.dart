import 'dart:convert';

import 'package:http/http.dart' as http;

import 'api_client.dart';

/// On-device fixture context from ESPN's key-less scoreboard endpoint --
/// the same source the backend polls (backend/lib/espn.js), fetched
/// directly by the phone so the feed has real data with zero backend.
///
/// These rows are display-only context: `selectionCount` stays 0, they are
/// never scored, and they carry no prices beyond what ESPN's public payload
/// shows (its odds summary string when present). Nothing is fabricated:
/// a league that fails or returns nothing contributes no rows.
class FixturePulse {
  FixturePulse({http.Client? httpClient, this.limit = 10})
      : _client = httpClient ?? http.Client();

  final http.Client _client;
  final int limit;

  static const defaultLeagues = ['eng.1'];

  Future<List<PostFeedEntry>> fetch({List<String>? leagues}) async {
    final rows = <PostFeedEntry>[];
    for (final league in leagues ?? defaultLeagues) {
      try {
        final res = await _client
            .get(Uri.parse(
                'https://site.api.espn.com/apis/site/v2/sports/soccer/$league/scoreboard'))
            .timeout(const Duration(seconds: 25));
        if (res.statusCode != 200) continue;
        final body = jsonDecode(res.body) as Map<String, dynamic>;
        final events = body['events'] as List<dynamic>? ?? const [];
        for (final e in events) {
          if (e is! Map<String, dynamic>) continue;
          final row = _row(league, e);
          if (row != null) rows.add(row);
        }
      } catch (_) {
        // No network / blocked endpoint -- contribute nothing, honestly.
      }
    }
    rows.sort((a, b) => (a.postedAt ?? '').compareTo(b.postedAt ?? ''));
    return rows.take(limit).toList();
  }

  PostFeedEntry? _row(String league, Map<String, dynamic> event) {
    final id = event['id']?.toString();
    final date = event['date']?.toString();
    if (id == null || date == null) return null;
    final competitions = event['competitions'] as List<dynamic>? ?? const [];
    final competition =
        competitions.isNotEmpty ? competitions.first as Map<String, dynamic> : null;
    final competitors = competition?['competitors'] as List<dynamic>? ?? const [];
    String? home;
    String? away;
    for (final c in competitors) {
      if (c is! Map<String, dynamic>) continue;
      final name = c['displayName']?.toString() ?? c['team']?['displayName']?.toString();
      if (name == null) continue;
      if (c['homeAway'] == 'home') {
        home = name;
      } else if (c['homeAway'] == 'away') {
        away = name;
      }
    }
    if (home == null || away == null) return null;

    final lines = <String>[
      '$home vs $away',
      'Kick-off ${DateTime.tryParse(date)?.toLocal().toString().substring(0, 16) ?? date}',
    ];
    final odds = competition?['odds'];
    if (odds is List<dynamic> && odds.isNotEmpty && odds.first is Map<String, dynamic>) {
      final first = odds.first as Map<String, dynamic>;
      final details = first['details']?.toString();
      final provider = first['provider']?['name']?.toString();
      if (details != null && details.isNotEmpty) {
        lines.add(provider == null ? 'Odds: $details' : '$provider: $details');
      }
    }

    return PostFeedEntry(
      id: 'pulse-$id',
      sourceHandle: 'fixture-pulse',
      sourceDisplayName: 'Fixture pulse',
      rawText: lines.join('\n'),
      postedAt: date,
      selectionCount: 0,
      sourceKind: PostKind.context,
    );
  }
}
