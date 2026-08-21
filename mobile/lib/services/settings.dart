import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// App-level settings:
/// - the followed Telegram channels (public usernames, no @) -- scanned
///   directly on-device via t.me/s, tradeapp-style;
/// - an optional cloud backend URL (typed in-app, tradeapp's Settings
///   pattern) -- enables server-side pick parsing/settling/scoring and
///   push registration; empty means fully standalone;
/// - the in-app "Reduce transparency" toggle docs/DESIGN.md §11.3a/§11.4
///   requires: Flutter has no OS-level signal for
///   `prefers-reduced-transparency` (unlike reduce-motion and
///   high-contrast, which `MediaQuery` exposes directly), so every
///   `BackdropFilter` surface needs to read this and fall back to solid.
class AppSettings extends ChangeNotifier {
  AppSettings({String defaultCloudUrl = ''}) : _cloudUrl = defaultCloudUrl;

  static const _reduceTransparencyKey = 'reduce_transparency';
  static const _channelsKey = 'telegram_channels';
  static const _cloudUrlKey = 'cloud_url';
  static const _redditEnabledKey = 'source_reddit_enabled';
  static const _rssEnabledKey = 'source_rss_enabled';
  static const _espnEnabledKey = 'source_espn_enabled';
  static const _telegramEnabledKey = 'source_telegram_enabled';
  static const _redditSubsKey = 'reddit_subs';

  bool _reduceTransparency = false;
  bool get reduceTransparency => _reduceTransparency;

  List<String> _channels = const [];
  List<String> get telegramChannels => List.unmodifiable(_channels);

  String _cloudUrl;
  String get cloudUrl => _cloudUrl;
  bool get cloudConfigured => _cloudUrl.trim().isNotEmpty;

  // Per-source switches -- tradeapp's sourcesEnabled pattern. All default
  // ON so a fresh install has information immediately.
  bool _telegramEnabled = true;
  bool get telegramEnabled => _telegramEnabled;
  bool _redditEnabled = true;
  bool get redditEnabled => _redditEnabled;
  bool _rssEnabled = true;
  bool get rssEnabled => _rssEnabled;
  bool _espnEnabled = true;
  bool get espnEnabled => _espnEnabled;

  List<String> _redditSubs = RedditDefaults.subs;
  List<String> get redditSubs => List.unmodifiable(_redditSubs);

  Future<void> load() async {
    final prefs = await SharedPreferences.getInstance();
    _reduceTransparency = prefs.getBool(_reduceTransparencyKey) ?? false;
    _channels =
        (prefs.getStringList(_channelsKey) ?? const []).map((c) => c.trim()).where((c) => c.isNotEmpty).toList();
    final savedUrl = prefs.getString(_cloudUrlKey);
    if (savedUrl != null) _cloudUrl = savedUrl.trim();
    _telegramEnabled = prefs.getBool(_telegramEnabledKey) ?? true;
    _redditEnabled = prefs.getBool(_redditEnabledKey) ?? true;
    _rssEnabled = prefs.getBool(_rssEnabledKey) ?? true;
    _espnEnabled = prefs.getBool(_espnEnabledKey) ?? true;
    final savedSubs =
        (prefs.getStringList(_redditSubsKey) ?? const []).map((s) => s.trim()).where((s) => s.isNotEmpty).toList();
    if (savedSubs.isNotEmpty) _redditSubs = savedSubs;
    notifyListeners();
  }

  /// Signature of everything that changes what the feed loads -- screens
  /// compare this to detect "settings changed, reload".
  String get feedSignature =>
      '${_cloudUrl.trim().toLowerCase()}|${_channels.join(',')}|$_telegramEnabled|'
      '$_redditEnabled|${_redditSubs.join(',')}|$_rssEnabled|$_espnEnabled';

  Future<void> setReduceTransparency(bool value) async {
    _reduceTransparency = value;
    notifyListeners();
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool(_reduceTransparencyKey, value);
  }

  Future<void> setTelegramChannels(Iterable<String> channels) async {
    _channels = channels.map((c) => c.trim().replaceFirst(RegExp('^@'), '')).where((c) => c.isNotEmpty).toList();
    notifyListeners();
    final prefs = await SharedPreferences.getInstance();
    await prefs.setStringList(_channelsKey, _channels);
  }

  Future<void> setCloudUrl(String url) async {
    _cloudUrl = url.trim().replaceFirst(RegExp(r'/+$'), '');
    notifyListeners();
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_cloudUrlKey, _cloudUrl);
  }

  void setSourceEnabled({bool? telegram, bool? reddit, bool? rss, bool? espn}) {
    if (telegram != null) _telegramEnabled = telegram;
    if (reddit != null) _redditEnabled = reddit;
    if (rss != null) _rssEnabled = rss;
    if (espn != null) _espnEnabled = espn;
    notifyListeners();
    SharedPreferences.getInstance().then((prefs) {
      prefs
        ..setBool(_telegramEnabledKey, _telegramEnabled)
        ..setBool(_redditEnabledKey, _redditEnabled)
        ..setBool(_rssEnabledKey, _rssEnabled)
        ..setBool(_espnEnabledKey, _espnEnabled);
    });
  }

  Future<void> setRedditSubs(Iterable<String> subs) async {
    _redditSubs = subs.map((s) => s.trim().replaceFirst(RegExp('^r/'), '')).where((s) => s.isNotEmpty).toList();
    notifyListeners();
    final prefs = await SharedPreferences.getInstance();
    await prefs.setStringList(_redditSubsKey, _redditSubs);
  }
}

/// Indirection so settings.dart doesn't import the Reddit source (and the
/// Reddit source's defaults stay next to its parser).
class RedditDefaults {
  static const subs = ['SoccerBetting', 'sportsbook'];
}
