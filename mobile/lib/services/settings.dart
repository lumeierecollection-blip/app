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

  bool _reduceTransparency = false;
  bool get reduceTransparency => _reduceTransparency;

  List<String> _channels = const [];
  List<String> get telegramChannels => List.unmodifiable(_channels);

  String _cloudUrl;
  String get cloudUrl => _cloudUrl;
  bool get cloudConfigured => _cloudUrl.trim().isNotEmpty;

  Future<void> load() async {
    final prefs = await SharedPreferences.getInstance();
    _reduceTransparency = prefs.getBool(_reduceTransparencyKey) ?? false;
    _channels =
        (prefs.getStringList(_channelsKey) ?? const []).map((c) => c.trim()).where((c) => c.isNotEmpty).toList();
    final savedUrl = prefs.getString(_cloudUrlKey);
    if (savedUrl != null) _cloudUrl = savedUrl.trim();
    notifyListeners();
  }

  /// Signature of everything that changes what the feed loads -- screens
  /// compare this to detect "settings changed, reload".
  String get feedSignature =>
      '${_cloudUrl.trim().toLowerCase()}|${_channels.join(',')}';

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
}
